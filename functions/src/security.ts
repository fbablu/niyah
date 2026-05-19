import { timingSafeEqual } from "node:crypto";

export interface GroupSessionPayoutParticipant {
  completed?: boolean;
}

// ─── Admin key (constant-time) ──────────────────────────────────────────────

/**
 * Constant-time admin key comparison. Returns true iff `provided` matches
 * `expected`, both are non-empty strings, and the secret has at least the
 * minimum length. Length pre-check is leak-safe — the worst signal is
 * "secret is short", and a short secret is rejected anyway.
 */
export function compareAdminKey(
  provided: unknown,
  expected: unknown,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (!expected || expected.length < 16) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── App Check token gate ────────────────────────────────────────────────────

export type AppCheckVerifier = (token: string) => Promise<void>;

/**
 * Pure-ish App Check gate, separated from `admin.appCheck()` so unit tests
 * can inject a stub verifier. Returns void on success, throws otherwise.
 *
 *   - missing / non-string / "skip-dev" → "App Check attestation required"
 *   - verifier rejects → "Invalid App Check token"
 */
export async function evaluateAppCheckToken(
  rawToken: unknown,
  verify: AppCheckVerifier,
): Promise<void> {
  if (!rawToken || typeof rawToken !== "string" || rawToken === "skip-dev") {
    throw new Error("App Check attestation required");
  }
  try {
    await verify(rawToken);
  } catch (err) {
    console.warn("app_check_verify_failed:", err);
    throw new Error("Invalid App Check token");
  }
}

export type ReferralClaimDecision =
  | { status: "claim" }
  | { status: "already_claimed"; sameReferrer: boolean };

export function isValidFirebaseUid(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9]{1,128}$/.test(value);
}

export function calculateGroupSessionPayouts(
  participantIds: string[],
  participants: Record<string, GroupSessionPayoutParticipant>,
  stakePerParticipant: number,
): Record<string, number> {
  const completers = participantIds.filter(
    (pid) => participants[pid]?.completed,
  );
  const totalPool = participantIds.length * stakePerParticipant;
  const payouts: Record<string, number> = {};

  if (completers.length === 0) {
    for (const pid of participantIds) {
      payouts[pid] = 0;
    }
    return payouts;
  }

  const payoutPerCompleter = Math.floor(totalPool / completers.length);
  for (const pid of participantIds) {
    payouts[pid] = participants[pid]?.completed ? payoutPerCompleter : 0;
  }

  return payouts;
}

export function buildStoredPayouts(
  participantIds: string[],
  rawPayouts: Record<string, unknown>,
): Array<{ userId: string; amount: number }> {
  return participantIds.map((userId) => {
    const rawAmount = rawPayouts[userId];
    const amount =
      typeof rawAmount === "number" && Number.isFinite(rawAmount)
        ? Math.max(0, Math.floor(rawAmount))
        : 0;

    return { userId, amount };
  });
}

export function decideReferralClaim(
  existingReferrerUid: unknown,
  requestedReferrerUid: string,
): ReferralClaimDecision {
  if (typeof existingReferrerUid !== "string" || !existingReferrerUid) {
    return { status: "claim" };
  }

  return {
    status: "already_claimed",
    sameReferrer: existingReferrerUid === requestedReferrerUid,
  };
}

// ─── Account-merge verification ──────────────────────────────────────────────

/**
 * Subset of `admin.auth().getUser()` we actually depend on. Avoids importing
 * the full admin SDK type into pure helpers so they stay test-friendly.
 */
export interface MinimalAuthRecord {
  uid: string;
  email?: string | null;
  emailVerified?: boolean;
  phoneNumber?: string | null;
  metadata: { creationTime: string };
}

export type AccountMergeDecision =
  | {
      status: "merge";
      newUid: string;
      existingUid: string;
      matchedField: "phone" | "email";
    }
  | { status: "no_match" }
  | { status: "self_match" }
  | { status: "no_verified_contact" };

const VERIFICATION_GRACE_MS = 5 * 60 * 1000; // 5 min

/**
 * Decide which uid is canonical and which is the duplicate when a user signs
 * in with a second provider whose verified contact already exists on another
 * account.
 *
 * Trust model:
 *   - We **only** trust auth-verified contacts. Firebase Auth populates
 *     `phoneNumber` after OTP success; `emailVerified` flips to true after
 *     the magic-link click. Firestore profile fields are user-writable and
 *     must NOT be consulted here.
 *   - The duplicate is the newer auth user. Older = canonical. Ties (same
 *     creation timestamp, within a grace window) resolve in favour of the
 *     caller staying put — pre-merge, we don't know which the human meant.
 *
 * Returns the decision the caller should act on. `mergeOne` and the
 * `requestAccountMerge` CF both consume this — keeping it pure means the
 * security-critical decision can be regression-tested directly.
 */
export function decideAccountMerge(
  caller: MinimalAuthRecord,
  candidate: MinimalAuthRecord,
): AccountMergeDecision {
  if (caller.uid === candidate.uid) return { status: "self_match" };

  const phoneMatch =
    !!caller.phoneNumber &&
    !!candidate.phoneNumber &&
    caller.phoneNumber === candidate.phoneNumber;

  const emailMatch =
    !!caller.email &&
    !!candidate.email &&
    caller.emailVerified === true &&
    candidate.emailVerified === true &&
    caller.email.toLowerCase() === candidate.email.toLowerCase();

  if (!phoneMatch && !emailMatch) return { status: "no_match" };

  const matchedField: "phone" | "email" = phoneMatch ? "phone" : "email";

  const callerCreated = Date.parse(caller.metadata.creationTime);
  const candidateCreated = Date.parse(candidate.metadata.creationTime);

  // Both bad timestamps — refuse rather than guess.
  if (!Number.isFinite(callerCreated) || !Number.isFinite(candidateCreated)) {
    return { status: "no_match" };
  }

  // Within the grace window we can't reliably pick a newer one; treat as
  // self-match so the caller stays on its current uid until a human merges
  // out-of-band. Prevents flapping during near-simultaneous account creates.
  if (Math.abs(callerCreated - candidateCreated) < VERIFICATION_GRACE_MS) {
    return { status: "self_match" };
  }

  if (callerCreated > candidateCreated) {
    return {
      status: "merge",
      newUid: caller.uid,
      existingUid: candidate.uid,
      matchedField,
    };
  }
  return {
    status: "merge",
    newUid: candidate.uid,
    existingUid: caller.uid,
    matchedField,
  };
}

/**
 * Sanity check used by `mergeOne` before any wallet/auth mutation: the two
 * accounts must still share a verified contact at merge time. Catches the
 * phone-squat case where a stale queue entry (written before phone/email
 * fields were locked) would otherwise move funds to an unrelated uid.
 */
export function authUsersShareVerifiedContact(
  a: MinimalAuthRecord,
  b: MinimalAuthRecord,
): boolean {
  if (a.uid === b.uid) return false;
  const phone =
    !!a.phoneNumber && !!b.phoneNumber && a.phoneNumber === b.phoneNumber;
  const email =
    !!a.email &&
    !!b.email &&
    a.emailVerified === true &&
    b.emailVerified === true &&
    a.email.toLowerCase() === b.email.toLowerCase();
  return phone || email;
}

export function calculateReferralReputation(rep: Record<string, unknown>): {
  referralCount: number;
  score: number;
  level: string;
} {
  const referralCount =
    (typeof rep.referralCount === "number" && Number.isFinite(rep.referralCount)
      ? rep.referralCount
      : 0) + 1;
  const paymentsCompleted =
    typeof rep.paymentsCompleted === "number" &&
    Number.isFinite(rep.paymentsCompleted)
      ? rep.paymentsCompleted
      : 0;
  const paymentsMissed =
    typeof rep.paymentsMissed === "number" &&
    Number.isFinite(rep.paymentsMissed)
      ? rep.paymentsMissed
      : 0;
  const totalPayments = paymentsCompleted + paymentsMissed;

  let score = 50;
  if (totalPayments > 0) {
    const successRate = paymentsCompleted / totalPayments;
    score = Math.round(50 + (successRate - 0.5) * 100);
    score = Math.max(0, Math.min(100, score));
  }

  score = Math.min(100, score + referralCount * 10);

  const level =
    score <= 20
      ? "seed"
      : score <= 40
        ? "sprout"
        : score <= 60
          ? "sapling"
          : score <= 80
            ? "tree"
            : "oak";

  return { referralCount, score, level };
}
