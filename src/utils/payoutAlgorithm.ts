import { GroupSessionDoc, SessionParticipant } from "../types";
import { SOLO_COMPLETION_MULTIPLIER } from "../constants/config";

export interface ParticipantResult {
  userId: string;
  completed: boolean;
  screenTime?: number; // ms of phone usage during session
}

export interface ParticipantPayout {
  userId: string;
  payout: number; // in cents
}

// Intermediate type used inside the store to build SessionTransfer objects.
export interface TransferDraft {
  fromUserId: string;
  fromUserName: string;
  toUserId: string;
  toUserName: string;
  amount: number; // in cents, always positive
}

/**
 * Calculate payouts for a completed session.
 *
 * Solo (1 participant) — Phase 2, not yet used by sessionStore:
 *   Niyah is the counterparty. Complete → stake × SOLO_COMPLETION_MULTIPLIER.
 *   Surrender → 0 (Niyah keeps the stake).
 *
 * Group (N > 1 participants) — Phase 1, primary mode:
 *   Peer-to-peer pool. Niyah takes no cut.
 *   Completers split the entire pool (all stakes) equally.
 *   Surrenderers get 0.
 *   Edge case: if all surrender, pool goes to Niyah (nobody receives anything).
 *   Edge case: if all complete, each gets their stake back (net $0 change).
 */
export const calculatePayouts = (
  stakePerParticipant: number,
  results: ParticipantResult[],
): ParticipantPayout[] => {
  const isSolo = results.length === 1;

  if (isSolo) {
    return results.map((r) => ({
      userId: r.userId,
      payout: r.completed
        ? stakePerParticipant * SOLO_COMPLETION_MULTIPLIER
        : 0,
    }));
  }

  // Group: completers split the full pool
  const completers = results.filter((r) => r.completed);
  if (completers.length === 0) {
    // All surrendered — nobody gets anything (Niyah keeps the pool)
    return results.map((r) => ({ userId: r.userId, payout: 0 }));
  }

  const totalPool = results.length * stakePerParticipant;
  // Floor to avoid fractional cents; any remainder stays with Niyah
  const payoutPerCompleter = Math.floor(totalPool / completers.length);

  return results.map((r) => ({
    userId: r.userId,
    payout: r.completed ? payoutPerCompleter : 0,
  }));
};

/**
 * Derive the transfers needed to settle the pool given each participant's
 * payout vs. contribution.
 *
 * Uses a greedy approach: drain each debtor against each creditor in order
 * of largest creditor first. This is correct but not Splitwise-optimal
 * (may produce more transfers than the theoretical minimum for N > 2).
 * The Splitwise-minimal version replaces this later.
 *
 * With the even-split dummy above all nets are 0, so this always returns [].
 */
export const calculateTransfers = (
  participants: Pick<SessionParticipant, "userId" | "name" | "stakeAmount">[],
  payouts: ParticipantPayout[],
): TransferDraft[] => {
  const nets = participants.map((p) => {
    const payout =
      payouts.find((pay) => pay.userId === p.userId)?.payout ?? p.stakeAmount;
    return {
      userId: p.userId,
      name: p.name,
      remaining: payout - p.stakeAmount,
    };
  });

  // Sort creditors largest-first so debtors are drained efficiently.
  const debtors = nets
    .filter((n) => n.remaining < 0)
    .map((n) => ({ ...n, remaining: Math.abs(n.remaining) }));
  const creditors = nets
    .filter((n) => n.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);

  const transfers: TransferDraft[] = [];

  for (const debtor of debtors) {
    for (const creditor of creditors) {
      if (debtor.remaining <= 0) break;
      if (creditor.remaining <= 0) continue;

      const amount = Math.min(debtor.remaining, creditor.remaining);
      transfers.push({
        fromUserId: debtor.userId,
        fromUserName: debtor.name,
        toUserId: creditor.userId,
        toUserName: creditor.name,
        amount,
      });
      debtor.remaining -= amount;
      creditor.remaining -= amount;
    }
  }

  return transfers;
};

export interface OptimisticPayoutRow {
  userId: string;
  // Even split share of pool if this participant completes given current state.
  // Surrendered participants get 0.
  estimatedPayout: number; // in cents
  share: number; // 0..1
  status: "focused" | "completed" | "surrendered";
}

/**
 * Live, optimistic payout preview that updates as participants surrender or
 * complete during an active group session. Mirrors the settlement logic in
 * `calculatePayouts` (even split among completers) but treats still-focused
 * participants as future completers so each remaining player sees their
 * upside grow when someone caves.
 *
 * Server-side `distributeGroupPayouts` is the authoritative settlement; this
 * is purely for in-session UI motivation.
 */
export const optimisticGroupPayouts = (
  session: Pick<GroupSessionDoc, "stakePerParticipant" | "participants">,
): OptimisticPayoutRow[] => {
  const entries = Object.entries(session.participants ?? {});
  if (entries.length <= 1) {
    return entries.map(([userId, p]) => ({
      userId,
      estimatedPayout: p.completed
        ? session.stakePerParticipant * SOLO_COMPLETION_MULTIPLIER
        : p.surrendered
          ? 0
          : session.stakePerParticipant * SOLO_COMPLETION_MULTIPLIER,
      share: p.surrendered ? 0 : 1,
      status: p.completed
        ? "completed"
        : p.surrendered
          ? "surrendered"
          : "focused",
    }));
  }

  const pool = session.stakePerParticipant * entries.length;
  const completers = entries.filter(
    ([, p]) => p.completed || !p.surrendered, // still in the run counts as a future completer
  );
  if (completers.length === 0) {
    return entries.map(([userId, p]) => ({
      userId,
      estimatedPayout: 0,
      share: 0,
      status: p.completed
        ? "completed"
        : p.surrendered
          ? "surrendered"
          : "focused",
    }));
  }
  const perCompleter = Math.floor(pool / completers.length);

  return entries.map(([userId, p]) => {
    const inRun = !p.surrendered;
    return {
      userId,
      estimatedPayout: inRun ? perCompleter : 0,
      share: inRun ? 1 / completers.length : 0,
      status: p.completed
        ? "completed"
        : p.surrendered
          ? "surrendered"
          : "focused",
    };
  });
};
