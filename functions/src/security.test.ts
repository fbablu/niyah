import assert from "node:assert/strict";
import test from "node:test";

import {
  authUsersShareVerifiedContact,
  buildStoredPayouts,
  calculateGroupSessionPayouts,
  calculateReferralReputation,
  compareAdminKey,
  decideAccountMerge,
  decideReferralClaim,
  evaluateAppCheckToken,
  isValidFirebaseUid,
  type MinimalAuthRecord,
} from "./security";

// Helpers for auth-merge tests.
const isoMinus = (ms: number): string =>
  new Date(Date.now() - ms).toISOString();
const minutesAgo = (m: number): string => isoMinus(m * 60 * 1000);

const authFixture = (
  override: Partial<MinimalAuthRecord> & { uid: string },
): MinimalAuthRecord => ({
  uid: override.uid,
  email: override.email ?? null,
  emailVerified: override.emailVerified ?? false,
  phoneNumber: override.phoneNumber ?? null,
  metadata: override.metadata ?? { creationTime: minutesAgo(60) },
});

test("calculateGroupSessionPayouts splits the pool across completers", () => {
  const payouts = calculateGroupSessionPayouts(
    ["alice", "bob", "cara"],
    {
      alice: { completed: true },
      bob: { completed: false },
      cara: { completed: true },
    },
    500,
  );

  assert.deepEqual(payouts, {
    alice: 750,
    bob: 0,
    cara: 750,
  });
});

test("buildStoredPayouts normalizes missing or invalid amounts", () => {
  const payouts = buildStoredPayouts(["alice", "bob", "cara"], {
    alice: 1500,
    bob: -20,
    cara: "oops",
  });

  assert.deepEqual(payouts, [
    { userId: "alice", amount: 1500 },
    { userId: "bob", amount: 0 },
    { userId: "cara", amount: 0 },
  ]);
});

test("decideReferralClaim allows only the first referrer", () => {
  assert.deepEqual(decideReferralClaim(undefined, "ref-1"), {
    status: "claim",
  });

  assert.deepEqual(decideReferralClaim("ref-1", "ref-1"), {
    status: "already_claimed",
    sameReferrer: true,
  });

  assert.deepEqual(decideReferralClaim("ref-1", "ref-2"), {
    status: "already_claimed",
    sameReferrer: false,
  });
});

test("calculateReferralReputation increments referral count and recalculates score", () => {
  const reputation = calculateReferralReputation({
    referralCount: 2,
    paymentsCompleted: 3,
    paymentsMissed: 1,
  });

  assert.deepEqual(reputation, {
    referralCount: 3,
    score: 100,
    level: "oak",
  });
});

test("isValidFirebaseUid accepts Firebase-style UIDs only", () => {
  assert.equal(isValidFirebaseUid("abc123XYZ"), true);
  assert.equal(isValidFirebaseUid("with-dash"), false);
  assert.equal(isValidFirebaseUid(""), false);
  assert.equal(isValidFirebaseUid(null), false);
});

// ─── decideAccountMerge ─────────────────────────────────────────────────────

test("decideAccountMerge → self_match when uids are identical", () => {
  const u = authFixture({
    uid: "same",
    phoneNumber: "+15555550100",
    metadata: { creationTime: minutesAgo(30) },
  });
  assert.equal(decideAccountMerge(u, u).status, "self_match");
});

test("decideAccountMerge → no_match when no shared contact", () => {
  const caller = authFixture({
    uid: "A",
    phoneNumber: "+15555550101",
    metadata: { creationTime: minutesAgo(30) },
  });
  const candidate = authFixture({
    uid: "B",
    phoneNumber: "+15555550102",
    metadata: { creationTime: minutesAgo(120) },
  });
  assert.equal(decideAccountMerge(caller, candidate).status, "no_match");
});

test("decideAccountMerge → matches on phone, picks newer caller as duplicate", () => {
  const caller = authFixture({
    uid: "newer",
    phoneNumber: "+15555550111",
    metadata: { creationTime: minutesAgo(5) },
  });
  const candidate = authFixture({
    uid: "older",
    phoneNumber: "+15555550111",
    metadata: { creationTime: minutesAgo(60) },
  });
  const result = decideAccountMerge(caller, candidate);
  assert.deepEqual(result, {
    status: "merge",
    newUid: "newer",
    existingUid: "older",
    matchedField: "phone",
  });
});

test("decideAccountMerge → flips direction when candidate is newer", () => {
  const caller = authFixture({
    uid: "older",
    phoneNumber: "+15555550112",
    metadata: { creationTime: minutesAgo(60) },
  });
  const candidate = authFixture({
    uid: "newer",
    phoneNumber: "+15555550112",
    metadata: { creationTime: minutesAgo(5) },
  });
  const result = decideAccountMerge(caller, candidate);
  assert.deepEqual(result, {
    status: "merge",
    newUid: "newer",
    existingUid: "older",
    matchedField: "phone",
  });
});

test("decideAccountMerge → matches verified email case-insensitively", () => {
  const caller = authFixture({
    uid: "newer",
    email: "Fardeen@Niyah.LIVE",
    emailVerified: true,
    metadata: { creationTime: minutesAgo(5) },
  });
  const candidate = authFixture({
    uid: "older",
    email: "fardeen@niyah.live",
    emailVerified: true,
    metadata: { creationTime: minutesAgo(60) },
  });
  const result = decideAccountMerge(caller, candidate);
  assert.equal(result.status, "merge");
  if (result.status === "merge") {
    assert.equal(result.matchedField, "email");
    assert.equal(result.newUid, "newer");
    assert.equal(result.existingUid, "older");
  }
});

test("decideAccountMerge → rejects email match when either side is unverified", () => {
  const caller = authFixture({
    uid: "A",
    email: "x@x.com",
    emailVerified: true,
    metadata: { creationTime: minutesAgo(5) },
  });
  const unverified = authFixture({
    uid: "B",
    email: "x@x.com",
    emailVerified: false,
    metadata: { creationTime: minutesAgo(60) },
  });
  assert.equal(decideAccountMerge(caller, unverified).status, "no_match");
});

test("decideAccountMerge → self_match inside the 5-minute creation grace window", () => {
  const t = Date.now();
  const caller = authFixture({
    uid: "A",
    phoneNumber: "+15555550199",
    metadata: { creationTime: new Date(t).toISOString() },
  });
  const candidate = authFixture({
    uid: "B",
    phoneNumber: "+15555550199",
    metadata: { creationTime: new Date(t + 60_000).toISOString() }, // 1 min apart
  });
  assert.equal(decideAccountMerge(caller, candidate).status, "self_match");
});

test("decideAccountMerge → no_match when creation timestamps are unparseable", () => {
  const caller = authFixture({
    uid: "A",
    phoneNumber: "+15555550120",
    metadata: { creationTime: "not-a-date" },
  });
  const candidate = authFixture({
    uid: "B",
    phoneNumber: "+15555550120",
    metadata: { creationTime: "also-not-a-date" },
  });
  assert.equal(decideAccountMerge(caller, candidate).status, "no_match");
});

test("decideAccountMerge → phone match wins over email match (deterministic)", () => {
  // If both phone AND email match, the function should pick "phone" so the
  // matchedField is deterministic and audit logs stay consistent.
  const caller = authFixture({
    uid: "newer",
    phoneNumber: "+15555550130",
    email: "z@z.com",
    emailVerified: true,
    metadata: { creationTime: minutesAgo(5) },
  });
  const candidate = authFixture({
    uid: "older",
    phoneNumber: "+15555550130",
    email: "z@z.com",
    emailVerified: true,
    metadata: { creationTime: minutesAgo(60) },
  });
  const result = decideAccountMerge(caller, candidate);
  assert.equal(result.status, "merge");
  if (result.status === "merge") assert.equal(result.matchedField, "phone");
});

// ─── authUsersShareVerifiedContact ──────────────────────────────────────────

test("authUsersShareVerifiedContact → true on matching verified phone", () => {
  const a = authFixture({ uid: "A", phoneNumber: "+15555550140" });
  const b = authFixture({ uid: "B", phoneNumber: "+15555550140" });
  assert.equal(authUsersShareVerifiedContact(a, b), true);
});

test("authUsersShareVerifiedContact → true on matching verified email (case-insensitive)", () => {
  const a = authFixture({
    uid: "A",
    email: "Same@Domain.com",
    emailVerified: true,
  });
  const b = authFixture({
    uid: "B",
    email: "same@domain.com",
    emailVerified: true,
  });
  assert.equal(authUsersShareVerifiedContact(a, b), true);
});

test("authUsersShareVerifiedContact → false when emails match but unverified", () => {
  const a = authFixture({
    uid: "A",
    email: "x@x.com",
    emailVerified: false,
  });
  const b = authFixture({
    uid: "B",
    email: "x@x.com",
    emailVerified: true,
  });
  assert.equal(authUsersShareVerifiedContact(a, b), false);
});

test("authUsersShareVerifiedContact → false when uids are identical", () => {
  const same = authFixture({ uid: "X", phoneNumber: "+15555550141" });
  assert.equal(authUsersShareVerifiedContact(same, same), false);
});

test("authUsersShareVerifiedContact → false when neither phone nor email matches", () => {
  const a = authFixture({ uid: "A", phoneNumber: "+15555550150" });
  const b = authFixture({ uid: "B", phoneNumber: "+15555550151" });
  assert.equal(authUsersShareVerifiedContact(a, b), false);
});

// ─── compareAdminKey ────────────────────────────────────────────────────────

const STRONG_KEY = "a".repeat(32); // ≥16 chars

test("compareAdminKey → true on exact match", () => {
  assert.equal(compareAdminKey(STRONG_KEY, STRONG_KEY), true);
});

test("compareAdminKey → false when provided differs by one char", () => {
  const tampered = "b" + STRONG_KEY.slice(1);
  assert.equal(compareAdminKey(tampered, STRONG_KEY), false);
});

test("compareAdminKey → false on length mismatch", () => {
  assert.equal(compareAdminKey(STRONG_KEY + "x", STRONG_KEY), false);
  assert.equal(compareAdminKey(STRONG_KEY.slice(1), STRONG_KEY), false);
});

test("compareAdminKey → false when provided is not a string", () => {
  assert.equal(compareAdminKey(undefined, STRONG_KEY), false);
  assert.equal(compareAdminKey(null, STRONG_KEY), false);
  assert.equal(compareAdminKey(12345, STRONG_KEY), false);
  assert.equal(compareAdminKey({}, STRONG_KEY), false);
});

test("compareAdminKey → refuses weak secrets (<16 chars) even if they match", () => {
  // A weak secret is a bug to flag in config — never accept it.
  assert.equal(compareAdminKey("short", "short"), false);
  assert.equal(compareAdminKey("a".repeat(15), "a".repeat(15)), false);
});

test("compareAdminKey → false when expected is empty/missing", () => {
  assert.equal(compareAdminKey(STRONG_KEY, ""), false);
  assert.equal(compareAdminKey(STRONG_KEY, undefined), false);
});

// ─── evaluateAppCheckToken ──────────────────────────────────────────────────

test("evaluateAppCheckToken → rejects missing token", async () => {
  await assert.rejects(
    () => evaluateAppCheckToken(undefined, async () => undefined),
    /App Check attestation required/,
  );
});

test("evaluateAppCheckToken → rejects non-string token", async () => {
  await assert.rejects(
    () => evaluateAppCheckToken(12345, async () => undefined),
    /App Check attestation required/,
  );
  await assert.rejects(
    () => evaluateAppCheckToken({}, async () => undefined),
    /App Check attestation required/,
  );
});

test('evaluateAppCheckToken → rejects "skip-dev" sentinel', async () => {
  await assert.rejects(
    () => evaluateAppCheckToken("skip-dev", async () => undefined),
    /App Check attestation required/,
  );
});

test("evaluateAppCheckToken → rejects when verifier throws", async () => {
  await assert.rejects(
    () =>
      evaluateAppCheckToken("real-token", async () => {
        throw new Error("boom");
      }),
    /Invalid App Check token/,
  );
});

test("evaluateAppCheckToken → resolves when verifier resolves", async () => {
  let seen = "";
  await evaluateAppCheckToken("real-token", async (t) => {
    seen = t;
  });
  assert.equal(seen, "real-token");
});
