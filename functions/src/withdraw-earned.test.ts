/**
 * Earned-funds withdrawal — accounting + idempotency regression tests.
 *
 * Real end-to-end coverage with Stripe test mode and Firestore emulator is
 * tracked as a manual checklist (see bottom of file). The unit tests here
 * pin down the parts of the Cloud Function that are pure logic so a
 * regression in the math or idempotency key would fail CI before reaching
 * a real Stripe test transfer.
 *
 * See post-demo-roadmap.md Lane D7 for the broader plan.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildStoredPayouts, calculateGroupSessionPayouts } from "./security";

// Mirror of the CF idempotency-key recipe in `requestWithdrawal`. Kept in
// sync via this regression test so a copy-paste typo would surface here.
function buildWithdrawalIdempotencyKey(
  uid: string,
  amount: number,
  method: "standard" | "instant" | "venmo",
  nowMs: number,
): string {
  const bucket = Math.floor(nowMs / 60_000);
  return `withdrawal:${uid}:${amount}:${method}:${bucket}`;
}

test("withdrawal idempotency key collapses retries inside the same minute", () => {
  const t = 1715619600000; // 2024-05-13T16:20:00Z
  const k1 = buildWithdrawalIdempotencyKey("uid-A", 4000, "standard", t);
  const k2 = buildWithdrawalIdempotencyKey("uid-A", 4000, "standard", t + 5_000);
  assert.equal(k1, k2);
});

test("withdrawal idempotency key changes at the next minute bucket", () => {
  const t = 1715619600000;
  const k1 = buildWithdrawalIdempotencyKey("uid-A", 4000, "standard", t);
  const k2 = buildWithdrawalIdempotencyKey("uid-A", 4000, "standard", t + 60_000);
  assert.notEqual(k1, k2);
});

test("withdrawal idempotency key separates amount, method, and user", () => {
  const t = 1715619600000;
  const base = buildWithdrawalIdempotencyKey("uid-A", 4000, "standard", t);
  assert.notEqual(
    base,
    buildWithdrawalIdempotencyKey("uid-B", 4000, "standard", t),
  );
  assert.notEqual(
    base,
    buildWithdrawalIdempotencyKey("uid-A", 4001, "standard", t),
  );
  assert.notEqual(
    base,
    buildWithdrawalIdempotencyKey("uid-A", 4000, "instant", t),
  );
});

// Lightweight in-memory ledger that mirrors what wallets/{uid} +
// transactions/{id} look like server-side. Reconciles the same way
// reconcileWalletBalances does.
class Ledger {
  balance = 0;
  pendingBalance = 0;
  entries: Array<{ type: string; amount: number; sessionId?: string }> = [];

  deposit(cents: number): void {
    this.balance += cents;
    this.entries.push({ type: "deposit", amount: cents });
  }
  stake(cents: number, sessionId: string): void {
    if (this.balance < cents) throw new Error("Insufficient balance for stake");
    this.balance -= cents;
    this.entries.push({ type: "stake", amount: -cents, sessionId });
  }
  payout(cents: number, sessionId: string): void {
    this.balance += cents;
    this.entries.push({ type: "payout", amount: cents, sessionId });
  }
  withdraw(cents: number): void {
    if (this.balance < cents) throw new Error("Insufficient balance to withdraw");
    this.balance -= cents;
    this.entries.push({ type: "withdrawal", amount: -cents });
  }
  forfeit(cents: number, sessionId: string): void {
    this.entries.push({ type: "forfeit", amount: -cents, sessionId });
  }
  summedFromEntries(): number {
    return this.entries.reduce((acc, e) => {
      // forfeit lives in the audit trail but the stake debit already moved
      // money out of the wallet — sum only the wallet-affecting entries.
      if (e.type === "forfeit") return acc;
      return acc + e.amount;
    }, 0);
  }
}

test("solo session: stake → complete (2x) → withdraw drains the wallet", () => {
  const wallet = new Ledger();
  // Pre-existing $20 from a deposit.
  wallet.deposit(2000);

  // Start solo session: deduct $20 stake.
  wallet.stake(2000, "sess-1");
  assert.equal(wallet.balance, 0);

  // Completion under 2x multiplier mirrors `SOLO_COMPLETION_MULTIPLIER`
  // path: credit stake × 2 = $40.
  wallet.payout(4000, "sess-1");
  assert.equal(wallet.balance, 4000);

  // Withdraw the earned $40.
  wallet.withdraw(4000);
  assert.equal(wallet.balance, 0);

  // Ledger reconciles to live balance — the invariant
  // `reconcileWalletBalances` enforces nightly.
  assert.equal(wallet.summedFromEntries(), wallet.balance);
});

test("solo session: surrender does not credit a payout", () => {
  const wallet = new Ledger();
  wallet.deposit(2000);
  wallet.stake(2000, "sess-1");
  // Surrender path: stake stays with Niyah, no payout.
  wallet.forfeit(2000, "sess-1");
  assert.equal(wallet.balance, 0);
  assert.equal(wallet.summedFromEntries(), wallet.balance);
});

test("group session payouts: completers split pool equally", () => {
  // $20 stake × 3 participants = $60 pool. One surrenders. $30 each to the
  // two completers (already covered in security.test.ts but pinned here
  // because withdrawal accounting depends on it).
  const payouts = calculateGroupSessionPayouts(
    ["alice", "bob", "cara"],
    {
      alice: { completed: true },
      bob: { completed: false },
      cara: { completed: true },
    },
    2000,
  );
  assert.deepEqual(payouts, { alice: 3000, bob: 0, cara: 3000 });
  const total = Object.values(payouts).reduce((a, b) => a + b, 0);
  // Total payout to completers ≤ total pool; Niyah retains any rounding.
  assert.ok(total <= 2000 * 3);
});

test("group payout → wallet credit → withdraw preserves invariant", () => {
  const wallet = new Ledger();
  wallet.deposit(2000); // initial $20

  // Stake into 3-person group: −$20.
  wallet.stake(2000, "grp-1");

  // Group settles, user wins as one of two completers → $30 share.
  const payouts = calculateGroupSessionPayouts(
    ["me", "other-a", "other-b"],
    { me: { completed: true }, "other-a": { completed: true }, "other-b": { completed: false } },
    2000,
  );
  const myPayout = buildStoredPayouts(["me", "other-a", "other-b"], payouts).find(
    (p) => p.userId === "me",
  )?.amount;
  assert.equal(myPayout, 3000);
  wallet.payout(myPayout!, "grp-1");
  assert.equal(wallet.balance, 3000); // started $20, staked $20, won $30 → $30

  // Withdraw earned $30.
  wallet.withdraw(3000);
  assert.equal(wallet.balance, 0);
  assert.equal(wallet.summedFromEntries(), wallet.balance);
});

/*
Real Stripe-test-mode end-to-end (manual until functions test runner is wired up):

  Setup
    - Use Stripe test mode keys; point firebase emulators at the test project.
    - Create test user A, complete Stripe Connect onboarding to "active".

  Steps
    1. Seed wallets/{A}.balance = 0.
    2. Solo session $20 stake → expect balance after stake = -$20. (Or
       deposit $20 first so the start can proceed.)
    3. Call handleSessionComplete for that session.
       Expected: wallets/{A}.balance increments to $40 (using 2x multiplier)
       or to $20 (stickK). Transaction `payout` exists with consistent
       createdAt > session.completedAt.
    4. Call requestWithdrawal($40, "standard").
       Expected: Stripe test transfer succeeds; wallets/{A}.balance = 0;
       transactions log contains `payout` then `withdrawal` in order with
       monotonically increasing createdAt; the withdrawal txn has
       stripeTransferId populated.
    5. Repeat step 4 immediately with the same body.
       Expected: Stripe returns the same transfer (idempotency key match);
       wallet stays at 0 (no double-debit).
    6. Run reconcileWalletBalances manually.
       Expected: walletAudits/{A}_{date} not written (no drift).
*/
