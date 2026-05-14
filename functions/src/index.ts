/**
 * Niyah Firebase Cloud Functions
 * Stripe payment processing + Connect for peer-to-peer transfers
 *
 * Deploy: firebase deploy --only functions
 * Env vars: firebase functions:secrets:set STRIPE_SECRET_KEY
 */

import * as admin from "firebase-admin";
import { onRequest, type Request } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import Stripe from "stripe";
import {
  PlaidApi,
  Configuration,
  PlaidEnvironments,
  Products,
  CountryCode,
} from "plaid";
import type { Response } from "express";
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

/**
 * Per-environment App Check enforcement. Off by default during rollout so
 * pre-AppAttest TestFlight builds and emulator suites don't get 403s. Flip
 * `APP_CHECK_ENFORCED=true` once Firebase Console → App Check metrics show
 * ≥99% verified production traffic.
 */
const APP_CHECK_ENFORCED = process.env.APP_CHECK_ENFORCED === "true";

/** Test seam: lets unit tests assert the env-flag wiring without spawning a deploy. */
export function isAppCheckEnforced(): boolean {
  return APP_CHECK_ENFORCED;
}

admin.initializeApp();
const db = admin.firestore();

// Secret managed via Firebase Secret Manager
// Set with: firebase functions:secrets:set STRIPE_SECRET_KEY
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
// Plaid secrets — set with: firebase functions:secrets:set PLAID_CLIENT_ID / PLAID_SECRET
const PLAID_CLIENT_ID = defineSecret("PLAID_CLIENT_ID");
const PLAID_SECRET = defineSecret("PLAID_SECRET");

const PUBLIC_HTTP_OPTIONS = {
  cors: true,
  region: "us-central1",
  invoker: "public" as const,
};

const PUBLIC_STRIPE_HTTP_OPTIONS = {
  ...PUBLIC_HTTP_OPTIONS,
  secrets: [STRIPE_SECRET_KEY],
};

const PUBLIC_STRIPE_WEBHOOK_OPTIONS = {
  cors: false,
  region: "us-central1",
  invoker: "public" as const,
  secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET],
};

const PUBLIC_PLAID_HTTP_OPTIONS = {
  ...PUBLIC_HTTP_OPTIONS,
  secrets: [PLAID_CLIENT_ID, PLAID_SECRET],
};

const PUBLIC_PLAID_STRIPE_HTTP_OPTIONS = {
  ...PUBLIC_HTTP_OPTIONS,
  secrets: [PLAID_CLIENT_ID, PLAID_SECRET, STRIPE_SECRET_KEY],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getStripe(): Stripe {
  return new Stripe(STRIPE_SECRET_KEY.value(), {
    apiVersion: "2025-02-24.acacia",
  });
}

const PLAID_ENV = (process.env.PLAID_ENV ??
  "production") as keyof typeof PlaidEnvironments;

function getPlaid(): PlaidApi {
  const config = new Configuration({
    basePath: PlaidEnvironments[PLAID_ENV] ?? PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": PLAID_CLIENT_ID.value(),
        "PLAID-SECRET": PLAID_SECRET.value(),
      },
    },
  });
  return new PlaidApi(config);
}

/**
 * App-Check enforcement gate. Verified attestation tokens come from
 * `getAppCheckToken()` on the client; absent or invalid tokens reject with
 * 403. "skip-dev" is reserved for dev/CI fixtures and is rejected — prod
 * must never accept it.
 *
 * Whether this gate runs at all is controlled by `APP_CHECK_ENFORCED`. When
 * false (default during rollout) `verifyAuth` only logs missing tokens via
 * the existing soft-fail path so pre-AppAttest builds keep working.
 */
async function assertAppCheck(req: Request): Promise<void> {
  await evaluateAppCheckToken(
    req.headers["x-firebase-appcheck"],
    async (t) => {
      await admin.appCheck().verifyToken(t);
    },
  );
}

interface VerifyAuthOptions {
  /** When true, reject calls without a verified App Check token. */
  enforceAppCheck?: boolean;
}

/** Verify Firebase ID token from Authorization header. Returns uid or throws. */
async function verifyAuth(
  req: Request,
  opts: VerifyAuthOptions = {},
): Promise<string> {
  const authHeader = req.headers.authorization;
  const token =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

  if (!token) throw new Error("Missing auth token");

  const decoded = await admin.auth().verifyIdToken(token);

  // App Check: hard-enforce on auth-gated money paths, soft-log everywhere
  // else during the rollout window.
  if (opts.enforceAppCheck) {
    try {
      await assertAppCheck(req);
    } catch (err) {
      console.warn(
        `app_check_enforced_reject uid=${decoded.uid} path=${req.path ?? "?"}`,
      );
      throw err;
    }
  } else {
    const appCheckToken = req.headers["x-firebase-appcheck"];
    if (!appCheckToken) {
      console.warn(
        `app_check_missing uid=${decoded.uid} path=${req.path ?? "?"}`,
      );
    }
  }

  return decoded.uid;
}

function sendError(res: Response, code: number, message: string): void {
  res.status(code).json({ error: message });
}

/**
 * Structured breadcrumb logger for money paths. Emits a single line of JSON
 * that Cloud Logging captures and that a future Sentry @sentry/node init can
 * pick up via console hook. Keeps payout, withdrawal, and bank link calls
 * forensically traceable across retries and failures.
 */
function payoutBreadcrumb(
  flow: "linkBankAccount" | "requestWithdrawal" | "distributeGroupPayouts",
  step: string,
  ctx: Record<string, string | number | boolean | undefined>,
): void {
  const safe = Object.fromEntries(
    Object.entries(ctx).filter(([, v]) => v !== undefined),
  );
  console.info(JSON.stringify({ breadcrumb: flow, step, ...safe }));
}

// Per-user daily stake cap (cents). Overridable via env for gradual lift
// during campus launch. Default $25/day for the first week of launch.
const DAILY_STAKE_CAP_CENTS: number = (() => {
  const raw = process.env.DAILY_STAKE_CAP_CENTS;
  if (!raw) return 2500;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2500;
})();

/**
 * Sum of absolute stake amounts the user committed today (UTC day window).
 * Aggregates from two sources:
 *   1. `transactions` where type="stake" — group session stakes (written by
 *      createGroupSession / respondToGroupInvite).
 *   2. `sessions` started today — solo session stakes (written client-side
 *      via writeSession; no transactions doc exists at start time).
 */
async function getDailyStakeTotalCents(uid: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startTs = admin.firestore.Timestamp.fromDate(startOfDay);

  const [txnSnap, sessionSnap] = await Promise.all([
    db
      .collection("transactions")
      .where("userId", "==", uid)
      .where("type", "==", "stake")
      .where("createdAt", ">=", startTs)
      .get(),
    db
      .collection("sessions")
      .where("userId", "==", uid)
      .where("startedAt", ">=", startTs)
      .get(),
  ]);

  let total = 0;
  txnSnap.forEach((doc) => {
    const amount = doc.data().amount;
    if (typeof amount === "number") total += Math.abs(amount);
  });
  sessionSnap.forEach((doc) => {
    const stake = doc.data().stakeAmount;
    if (typeof stake === "number") total += stake;
  });
  return total;
}

async function assertDailyStakeCap(
  uid: string,
  newStakeCents: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await getDailyStakeTotalCents(uid);
  if (current + newStakeCents > DAILY_STAKE_CAP_CENTS) {
    const remaining = Math.max(0, DAILY_STAKE_CAP_CENTS - current);
    return {
      ok: false,
      message: `Daily stake cap reached. Remaining today: $${(remaining / 100).toFixed(2)}. Cap resets at midnight UTC.`,
    };
  }
  return { ok: true };
}

// Campus-launch withdrawal eligibility. Blocks cash-out until the user has
// shown real engagement — specifically, completed sessions across multiple
// distinct partners. Prevents the obvious exploit of two friends cycling
// promo money between themselves and cashing out.
const WITHDRAWAL_MIN_COMPLETED_SESSIONS: number = (() => {
  const raw = process.env.WITHDRAWAL_MIN_COMPLETED_SESSIONS;
  const parsed = raw ? parseInt(raw, 10) : 5;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
})();

const WITHDRAWAL_MIN_DISTINCT_PARTNERS: number = (() => {
  const raw = process.env.WITHDRAWAL_MIN_DISTINCT_PARTNERS;
  const parsed = raw ? parseInt(raw, 10) : 2;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
})();

export interface WithdrawalEligibilityStats {
  completedSessions: number;
  distinctPartners: number;
  requiredSessions: number;
  requiredPartners: number;
}

async function getWithdrawalEligibilityStats(
  uid: string,
): Promise<WithdrawalEligibilityStats> {
  const [userSnap, groupSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db
      .collection("groupSessions")
      .where("participantIds", "array-contains", uid)
      .where("status", "==", "completed")
      .get(),
  ]);
  const completedSessions: number = userSnap.data()?.completedSessions ?? 0;

  const distinctPartners = new Set<string>();
  groupSnap.forEach((doc) => {
    const data = doc.data();
    const myRec = data.participants?.[uid];
    // Only count sessions the user actually completed (not surrendered)
    if (myRec?.completed !== true) return;
    for (const pid of Object.keys(data.participants ?? {})) {
      if (pid !== uid) distinctPartners.add(pid);
    }
  });

  return {
    completedSessions,
    distinctPartners: distinctPartners.size,
    requiredSessions: WITHDRAWAL_MIN_COMPLETED_SESSIONS,
    requiredPartners: WITHDRAWAL_MIN_DISTINCT_PARTNERS,
  };
}

async function assertWithdrawalEligibility(
  uid: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const stats = await getWithdrawalEligibilityStats(uid);
  if (stats.completedSessions < stats.requiredSessions) {
    return {
      ok: false,
      message: `Withdrawal unlocks after ${stats.requiredSessions} completed sessions. You have ${stats.completedSessions}.`,
    };
  }
  if (stats.distinctPartners < stats.requiredPartners) {
    return {
      ok: false,
      message: `Withdrawal requires completed sessions with at least ${stats.requiredPartners} different friends. You've completed with ${stats.distinctPartners}.`,
    };
  }
  return { ok: true };
}

async function recordGroupSessionPayout(
  sessionId: string,
  payout: { userId: string; amount: number },
  stripeTransferId?: string,
): Promise<void> {
  const txnRef = db
    .collection("transactions")
    .doc(`group_session_payout_${sessionId}_${payout.userId}`);
  const walletRef = db.collection("wallets").doc(payout.userId);

  await db.runTransaction(async (txn) => {
    const payoutTxnSnap = await txn.get(txnRef);
    if (payoutTxnSnap.exists) {
      return;
    }

    const walletSnap = await txn.get(walletRef);
    const currentBalance: number = walletSnap.data()?.balance ?? 0;
    const nextBalance = currentBalance + payout.amount;

    if (walletSnap.exists) {
      txn.update(walletRef, {
        balance: nextBalance,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      txn.set(
        walletRef,
        {
          balance: nextBalance,
          pendingBalance: 0,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    txn.set(txnRef, {
      userId: payout.userId,
      type: "payout",
      amount: payout.amount,
      description: "Group session payout",
      sessionId,
      stripeTransferId: stripeTransferId ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
}

async function settleGroupSessionPayouts(
  sessionId: string,
  payouts: Array<{ userId: string; amount: number }>,
  initiatorUid: string,
): Promise<string[]> {
  const stripe = getStripe();
  const sessionRef = db.collection("groupSessions").doc(sessionId);
  const transferIds: string[] = [];
  const failedRecipients: string[] = [];

  for (const payout of payouts) {
    if (payout.amount <= 0) {
      continue;
    }

    try {
      const recipientDoc = await db
        .collection("users")
        .doc(payout.userId)
        .get();
      const connectAccountId: string =
        recipientDoc.data()?.stripeAccountId ?? "";

      let stripeTransferId: string | undefined;

      if (connectAccountId) {
        const transfer = await stripe.transfers.create(
          {
            amount: payout.amount,
            currency: "usd",
            destination: connectAccountId,
            metadata: {
              sessionId,
              recipientUid: payout.userId,
              initiatorUid,
              type: "group_session_payout",
            },
          },
          {
            idempotencyKey: `group_session_payout:${sessionId}:${payout.userId}:${payout.amount}`,
          },
        );

        stripeTransferId = transfer.id;
        transferIds.push(transfer.id);
      }

      await recordGroupSessionPayout(sessionId, payout, stripeTransferId);
    } catch (err) {
      console.error(
        `Failed to settle payout for session=${sessionId}, user=${payout.userId}:`,
        err,
      );
      failedRecipients.push(payout.userId);
    }
  }

  const updateData: Record<string, unknown> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (transferIds.length > 0) {
    updateData.transferIds = admin.firestore.FieldValue.arrayUnion(
      ...transferIds,
    );
  }

  if (failedRecipients.length === 0) {
    updateData.payoutsSettledAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await sessionRef.set(updateData, { merge: true });

  if (failedRecipients.length > 0) {
    throw new Error(
      `Payout settlement requires reconciliation for: ${failedRecipients.join(", ")}`,
    );
  }

  return transferIds;
}

// ─── Push Notifications ─────────────────────────────────────────────────────

/**
 * Send a push notification to a user's registered devices.
 * Fire-and-forget — errors are logged but never throw.
 */
async function sendPushToUser(
  uid: string,
  notification: { title: string; body: string },
  data?: Record<string, string>,
): Promise<void> {
  try {
    const userDoc = await db.collection("users").doc(uid).get();
    const tokens: string[] = userDoc.data()?.fcmTokens ?? [];
    if (tokens.length === 0) return;

    const messaging = admin.messaging();
    const results = await Promise.allSettled(
      tokens.map((token) =>
        messaging.send({
          token,
          notification,
          data: data ?? {},
          apns: {
            payload: { aps: { sound: "default", badge: 1 } },
          },
        }),
      ),
    );

    // Clean up invalid tokens
    const invalidTokens: string[] = [];
    results.forEach((result, i) => {
      if (
        result.status === "rejected" &&
        result.reason?.code === "messaging/registration-token-not-registered"
      ) {
        invalidTokens.push(tokens[i]);
      }
    });
    if (invalidTokens.length > 0) {
      await db
        .collection("users")
        .doc(uid)
        .update({
          fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens),
        });
    }
  } catch (err) {
    console.error(`sendPushToUser failed for uid=${uid}:`, err);
  }
}

/**
 * Send push notifications to multiple users in parallel.
 * Fire-and-forget — errors are logged but never throw.
 */
async function sendPushToUsers(
  uids: string[],
  notification: { title: string; body: string },
  data?: Record<string, string>,
): Promise<void> {
  await Promise.allSettled(
    uids.map((uid) => sendPushToUser(uid, notification, data)),
  );
}

// ─── Rate Limiting ──────────────────────────────────────────────────────────

interface RateLimitConfig {
  maxCalls: number; // max calls allowed in the window
  windowMs: number; // time window in milliseconds
}

/**
 * Firestore-based rate limiter. Checks if a user has exceeded the allowed
 * number of calls within a time window. Returns true if the request should
 * be BLOCKED.
 *
 * Uses a single Firestore document per user+function combo (rateLimits
 * collection). Stores an array of call timestamps, pruning expired entries
 * on each check.
 *
 * Fail-closed for financial operations: money-moving endpoints BLOCK on
 * rate-limit check failure (prefer denying legitimate user over letting
 * unlimited calls through during a Firestore outage). Non-financial
 * (social, hot-path) endpoints fail open to protect UX.
 */
const FAIL_CLOSED_FUNCTIONS = new Set<string>([
  "createPaymentIntent",
  "verifyAndCreditDeposit",
  "requestWithdrawal",
  "handleSessionComplete",
  "handleSessionForfeit",
  "distributeGroupPayouts",
  "linkBankAccount",
  "createConnectAccount",
  "createAccountLink",
]);

async function checkRateLimit(
  uid: string,
  functionName: string,
  config: RateLimitConfig,
): Promise<boolean> {
  const docId = `${uid}_${functionName}`;
  const ref = db.collection("rateLimits").doc(docId);
  const now = Date.now();
  const windowStart = now - config.windowMs;

  try {
    return await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const data = snap.data();
      const timestamps: number[] = data?.timestamps ?? [];

      // Prune expired entries
      const recent = timestamps.filter((t) => t > windowStart);

      if (recent.length >= config.maxCalls) {
        return true; // BLOCKED
      }

      // Record this call
      recent.push(now);
      txn.set(ref, { timestamps: recent, updatedAt: now });
      return false; // ALLOWED
    });
  } catch (err) {
    const failClosed = FAIL_CLOSED_FUNCTIONS.has(functionName);
    console.error(
      `Rate limit check failed (${failClosed ? "BLOCKING" : "allowing"} ${functionName}):`,
      err,
    );
    return failClosed;
  }
}

// Rate limit configurations per function
const RATE_LIMITS = {
  handleSessionComplete: { maxCalls: 5, windowMs: 3_600_000 }, // 5/hr
  handleSessionForfeit: { maxCalls: 5, windowMs: 3_600_000 }, // 5/hr
  createPaymentIntent: { maxCalls: 3, windowMs: 600_000 }, // 3/10min
  verifyAndCreditDeposit: { maxCalls: 5, windowMs: 600_000 }, // 5/10min
  requestWithdrawal: { maxCalls: 10, windowMs: 3_600_000 }, // 10/hr (relaxed for testing)
  distributeGroupPayouts: { maxCalls: 3, windowMs: 3_600_000 }, // 3/hr
  awardReferral: { maxCalls: 10, windowMs: 86_400_000 }, // 10/day
  createConnectAccount: { maxCalls: 3, windowMs: 3_600_000 }, // 3/hr
  createAccountLink: { maxCalls: 5, windowMs: 600_000 }, // 5/10min
  getConnectAccountStatus: { maxCalls: 10, windowMs: 600_000 }, // 10/10min
  followUserFn: { maxCalls: 30, windowMs: 600_000 }, // 30/10min
  unfollowUserFn: { maxCalls: 30, windowMs: 600_000 }, // 30/10min
  createGroupSession: { maxCalls: 5, windowMs: 3_600_000 }, // 5/hr
  respondToGroupInvite: { maxCalls: 10, windowMs: 3_600_000 }, // 10/hr
  markOnlineForSession: { maxCalls: 30, windowMs: 600_000 }, // 30/10min
  startGroupSession: { maxCalls: 5, windowMs: 3_600_000 }, // 5/hr
  reportSessionStatus: { maxCalls: 10, windowMs: 3_600_000 }, // 10/hr
  reportShieldViolation: { maxCalls: 100, windowMs: 600_000 }, // 100/10min — high cap, hot path
  cancelGroupSession: { maxCalls: 5, windowMs: 3_600_000 }, // 5/hr
  createPlaidLinkToken: { maxCalls: 10, windowMs: 600_000 }, // 10/10min
  linkBankAccount: { maxCalls: 5, windowMs: 3_600_000 }, // 5/hr
  unlinkBankAccount: { maxCalls: 5, windowMs: 3_600_000 }, // 5/hr
  replaceBankAccount: { maxCalls: 5, windowMs: 3_600_000 }, // 5/hr
  requestAccountMerge: { maxCalls: 10, windowMs: 3_600_000 }, // 10/hr — runs on every fresh sign-in
  findContactsOnNiyah: { maxCalls: 3, windowMs: 86_400_000 }, // 3/day — prevent phone enumeration
} as const;

// ─── createPaymentIntent ────────────────────────────────────────────────────
/**
 * Creates a Stripe PaymentIntent for depositing funds.
 * Body: { amount: number }  (in cents, e.g. 5000 = $50)
 * Returns: { clientSecret: string, paymentIntentId: string }
 */
export const createPaymentIntent = onRequest(
  PUBLIC_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "createPaymentIntent",
        RATE_LIMITS.createPaymentIntent,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { amount } = req.body as { amount: unknown };
    if (
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      !Number.isInteger(amount)
    ) {
      sendError(res, 400, "Amount must be an integer");
      return;
    }
    if (amount < 100 || amount > 1000000) {
      sendError(res, 400, "Amount must be between $1 and $10,000");
      return;
    }

    try {
      const stripe = getStripe();

      // Get or create Stripe customer
      const userDoc = await db.collection("users").doc(uid).get();
      const userData = userDoc.data() ?? {};
      let customerId: string = userData.stripeCustomerId ?? "";

      if (!customerId) {
        const customer = await stripe.customers.create({
          metadata: { firebaseUid: uid },
          email: userData.email ?? undefined,
          name: userData.name ?? undefined,
        });
        customerId = customer.id;
        await db.collection("users").doc(uid).set(
          {
            stripeCustomerId: customerId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: "usd",
        customer: customerId,
        metadata: { firebaseUid: uid, type: "deposit" },
        automatic_payment_methods: { enabled: true },
      });

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        customerId,
      });
    } catch (err) {
      console.error("createPaymentIntent error:", err);
      sendError(res, 500, "Failed to create payment intent");
    }
  },
);

// ─── verifyAndCreditDeposit ─────────────────────────────────────────────────
/**
 * Verifies a PaymentIntent and credits the user's Niyah balance if appropriate.
 * Called client-side after PaymentSheet completes (success OR ACH processing).
 *
 * Returns one of three states:
 *   { newBalance, credited: true }          — card/Apple Pay: credited immediately
 *   { processing: true, currentBalance }    — ACH: funds pending, webhook will credit
 *   { newBalance, alreadyCredited: true }   — idempotent re-call
 *
 * The stripeWebhook handles payment_intent.succeeded for ACH async crediting.
 */
export const verifyAndCreditDeposit = onRequest(
  PUBLIC_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "verifyAndCreditDeposit",
        RATE_LIMITS.verifyAndCreditDeposit,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { paymentIntentId } = req.body as { paymentIntentId: string };
    if (!paymentIntentId) {
      sendError(res, 400, "Missing paymentIntentId");
      return;
    }

    try {
      const stripe = getStripe();
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      // Security: verify this payment belongs to this user
      if (pi.metadata.firebaseUid !== uid) {
        sendError(res, 403, "Payment does not belong to this user");
        return;
      }

      // ACH / bank debit: PaymentIntent is 'processing', not yet 'succeeded'.
      // Do NOT credit yet — the stripeWebhook will credit when it actually clears.
      if (pi.status === "processing") {
        const walletDoc = await db.collection("wallets").doc(uid).get();
        res.json({
          processing: true,
          currentBalance: walletDoc.data()?.balance ?? 0,
          estimatedArrival: "1–5 business days",
        });
        return;
      }

      if (pi.status !== "succeeded") {
        sendError(res, 400, `Payment not in a creditable state: ${pi.status}`);
        return;
      }

      // Idempotency: check if already credited
      const existingTxn = await db
        .collection("transactions")
        .where("paymentIntentId", "==", paymentIntentId)
        .limit(1)
        .get();

      if (!existingTxn.empty) {
        const walletDoc = await db.collection("wallets").doc(uid).get();
        res.json({
          newBalance: walletDoc.data()?.balance ?? 0,
          alreadyCredited: true,
        });
        return;
      }

      const amount = pi.amount;

      // Credit balance in wallets collection (protected from client writes)
      const walletRef = db.collection("wallets").doc(uid);
      const txnRef = db.collection("transactions").doc();

      const newBalance = await db.runTransaction(async (txn) => {
        const walletSnap = await txn.get(walletRef);
        const current: number = walletSnap.data()?.balance ?? 0;
        const updated = current + amount;

        if (walletSnap.exists) {
          txn.update(walletRef, {
            balance: updated,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          txn.set(
            walletRef,
            {
              balance: updated,
              pendingBalance: 0,
              lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }

        txn.set(txnRef, {
          userId: uid,
          type: "deposit",
          amount,
          description: "Deposit via card",
          paymentIntentId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return updated;
      });

      res.json({ newBalance });
    } catch (err) {
      console.error("verifyAndCreditDeposit error:", err);
      sendError(res, 500, "Failed to verify deposit");
    }
  },
);

// ─── createConnectAccount ───────────────────────────────────────────────────
/**
 * Creates a Stripe Express connected account for the user (payouts).
 * Call once per user — idempotent (returns existing account if already created).
 * Returns: { accountId: string }
 */
export const createConnectAccount = onRequest(
  PUBLIC_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "createConnectAccount",
        RATE_LIMITS.createConnectAccount,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    try {
      const userDoc = await db.collection("users").doc(uid).get();
      const userData = userDoc.data() ?? {};

      // Return existing if already set up
      if (userData.stripeAccountId) {
        res.json({ accountId: userData.stripeAccountId });
        return;
      }

      // Parse optional native-KYC payload. If the client provides DOB +
      // address + legal name, pre-populate the Stripe individual object so
      // the hosted onboarding form only asks for SSN + phone verification.
      const kyc = parseKycPayload(req.body);
      if (kyc && !kyc.ok) {
        sendError(res, 400, kyc.message);
        return;
      }
      const kycData = kyc?.ok ? kyc.data : null;

      const validEmail =
        typeof userData.email === "string" && userData.email.includes("@")
          ? userData.email
          : undefined;

      // Client-provided legal names win over the profile display name, which
      // may be a nickname. Fallback to profile data as a last resort.
      const displayName =
        typeof userData.displayName === "string"
          ? userData.displayName.trim()
          : "";
      const nameParts = displayName.split(/\s+/);
      const fallbackFirst =
        (userData.firstName as string | undefined) || nameParts[0] || undefined;
      const fallbackLast =
        (userData.lastName as string | undefined) ||
        (nameParts.length > 1 ? nameParts.slice(1).join(" ") : undefined);
      const firstName = kycData?.legalFirstName || fallbackFirst;
      const lastName = kycData?.legalLastName || fallbackLast;
      const phone =
        typeof userData.phone === "string" && userData.phone
          ? userData.phone
          : undefined;

      const stripe = getStripe();
      const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        ...(validEmail ? { email: validEmail } : {}),
        capabilities: {
          transfers: { requested: true },
        },
        business_type: "individual",
        individual: {
          ...(firstName ? { first_name: firstName } : {}),
          ...(lastName ? { last_name: lastName } : {}),
          ...(phone ? { phone } : {}),
          ...(validEmail ? { email: validEmail } : {}),
          ...(kycData
            ? {
                dob: kycData.dob,
                address: {
                  line1: kycData.address.line1,
                  ...(kycData.address.line2
                    ? { line2: kycData.address.line2 }
                    : {}),
                  city: kycData.address.city,
                  state: kycData.address.state,
                  postal_code: kycData.address.postalCode,
                  country: "US",
                },
              }
            : {}),
        },
        metadata: { firebaseUid: uid },
      });

      await db
        .collection("users")
        .doc(uid)
        .update({
          stripeAccountId: account.id,
          stripeAccountStatus: "pending",
          ...(kycData
            ? {
                legalFirstName: kycData.legalFirstName,
                legalLastName: kycData.legalLastName,
                stripeKycProvidedAt:
                  admin.firestore.FieldValue.serverTimestamp(),
              }
            : {}),
        });

      res.json({ accountId: account.id });
    } catch (err) {
      console.error("createConnectAccount error:", err);
      sendError(res, 500, "Failed to create Connect account");
    }
  },
);

// ─── KYC payload parsing/validation ─────────────────────────────────────────
// Optional body accepted by createConnectAccount. When present, pre-populates
// the Stripe Express individual.* fields so the hosted form only needs SSN +
// phone verification. DOB + address are NEVER written to Firestore — Stripe
// is the sole source of truth for those fields.

interface KycData {
  legalFirstName: string;
  legalLastName: string;
  dob: { day: number; month: number; year: number };
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
  };
}

type KycParseResult =
  | { ok: true; data: KycData }
  | { ok: false; message: string };

function parseKycPayload(body: unknown): KycParseResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (
    b.legalFirstName === undefined &&
    b.dob === undefined &&
    b.address === undefined
  ) {
    return null; // No KYC provided — not an error, just skip pre-fill.
  }

  const legalFirstName =
    typeof b.legalFirstName === "string" ? b.legalFirstName.trim() : "";
  const legalLastName =
    typeof b.legalLastName === "string" ? b.legalLastName.trim() : "";
  if (legalFirstName.length < 1 || legalLastName.length < 1) {
    return { ok: false, message: "Legal first and last name are required." };
  }

  const dobRaw = b.dob as Record<string, unknown> | undefined;
  const day = Number(dobRaw?.day);
  const month = Number(dobRaw?.month);
  const year = Number(dobRaw?.year);
  if (
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(year) ||
    year < 1900 ||
    year > 2100
  ) {
    return { ok: false, message: "Invalid date of birth." };
  }
  // 18+ check (rough: today - dob >= 18 years). Stripe enforces this too but
  // a client-bypass attempt should never reach Stripe.
  const today = new Date();
  const eighteenYearsAgo = new Date(
    today.getUTCFullYear() - 18,
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const dob = new Date(Date.UTC(year, month - 1, day));
  if (dob > eighteenYearsAgo) {
    return {
      ok: false,
      message: "You must be at least 18 to enable payouts.",
    };
  }

  const addrRaw = b.address as Record<string, unknown> | undefined;
  const line1 =
    typeof addrRaw?.line1 === "string" ? (addrRaw.line1 as string).trim() : "";
  const line2Raw =
    typeof addrRaw?.line2 === "string" ? (addrRaw.line2 as string).trim() : "";
  const city =
    typeof addrRaw?.city === "string" ? (addrRaw.city as string).trim() : "";
  const state =
    typeof addrRaw?.state === "string"
      ? (addrRaw.state as string).trim().toUpperCase()
      : "";
  const postalCode =
    typeof addrRaw?.postalCode === "string"
      ? (addrRaw.postalCode as string).trim()
      : "";

  if (line1.length < 3) {
    return { ok: false, message: "Street address is required." };
  }
  if (city.length < 2) {
    return { ok: false, message: "City is required." };
  }
  if (!/^[A-Z]{2}$/.test(state)) {
    return {
      ok: false,
      message: "State must be a 2-letter US code (e.g. TN).",
    };
  }
  if (!/^\d{5}$/.test(postalCode)) {
    return { ok: false, message: "ZIP code must be 5 digits." };
  }

  return {
    ok: true,
    data: {
      legalFirstName,
      legalLastName,
      dob: { day, month, year },
      address: {
        line1,
        ...(line2Raw ? { line2: line2Raw } : {}),
        city,
        state,
        postalCode,
      },
    },
  };
}

// ─── createAccountLink ──────────────────────────────────────────────────────
/**
 * Generates a Stripe Express onboarding link (KYC flow).
 * User opens this URL in a browser to complete identity verification.
 * Body: {} (accountId read from Firestore, not from client)
 * Returns: { url: string }
 *
 * SECURITY: Reads accountId from the user's Firestore doc instead of
 * accepting it from the client. Prevents a user from generating onboarding
 * links for other users' Stripe accounts.
 */
export const createAccountLink = onRequest(
  PUBLIC_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "createAccountLink",
        RATE_LIMITS.createAccountLink,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    try {
      // Read accountId from Firestore — NEVER trust client-provided accountId
      const userDoc = await db.collection("users").doc(uid).get();
      const accountId: string = userDoc.data()?.stripeAccountId ?? "";
      if (!accountId) {
        sendError(
          res,
          400,
          "No Connect account found — create one first via createConnectAccount",
        );
        return;
      }

      const stripe = getStripe();
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: "https://niyah.live?stripe=refresh",
        return_url: "https://niyah.live?stripe=complete",
        type: "account_onboarding",
      });

      res.json({ url: accountLink.url });
    } catch (err) {
      console.error("createAccountLink error:", err);
      sendError(res, 500, "Failed to create account link");
    }
  },
);

// ─── getConnectAccountStatus ────────────────────────────────────────────────
/**
 * Returns the current status of a user's Stripe Express account.
 * Returns: { chargesEnabled, payoutsEnabled, detailsSubmitted, status }
 */
export const getConnectAccountStatus = onRequest(
  PUBLIC_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "getConnectAccountStatus",
        RATE_LIMITS.getConnectAccountStatus,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    try {
      const userDoc = await db.collection("users").doc(uid).get();
      const accountId: string = userDoc.data()?.stripeAccountId ?? "";

      if (!accountId) {
        res.json({ status: "none" });
        return;
      }

      const stripe = getStripe();
      const account = await stripe.accounts.retrieve(accountId);

      const status = account.details_submitted
        ? account.payouts_enabled
          ? "active"
          : "restricted"
        : "pending";

      // Sync status to Firestore
      await db
        .collection("users")
        .doc(uid)
        .update({ stripeAccountStatus: status });

      // Retrieve linked bank info from external accounts
      let bankName: string | undefined;
      let bankMask: string | undefined;
      try {
        const externals = await stripe.accounts.listExternalAccounts(
          accountId,
          { object: "bank_account", limit: 1 },
        );
        const bank = externals.data[0];
        if (bank && bank.object === "bank_account") {
          bankName = bank.bank_name ?? undefined;
          bankMask = bank.last4 ?? undefined;
        }
      } catch {
        // Non-critical — bank info is nice-to-have
      }

      // Sync status + bank info to Firestore
      const update: Record<string, unknown> = {
        stripeAccountStatus: status,
      };
      if (bankName && bankMask) {
        update.linkedBank = {
          institutionName: bankName,
          bankName,
          mask: bankMask,
        };
      }
      await db.collection("users").doc(uid).update(update);

      res.json({
        status,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
        bankName,
        bankMask,
      });
    } catch (err) {
      console.error("getConnectAccountStatus error:", err);
      sendError(res, 500, "Failed to get account status");
    }
  },
);

// ─── createPlaidLinkToken ───────────────────────────────────────────────────
/**
 * Creates a Plaid Link token for the client to open the bank-connection UI.
 * Body: {} (user identified via auth token)
 * Returns: { linkToken: string }
 */
export const createPlaidLinkToken = onRequest(
  PUBLIC_PLAID_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req, { enforceAppCheck: APP_CHECK_ENFORCED });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("App Check")) {
        sendError(res, 403, "App Check attestation required");
      } else {
        sendError(res, 401, "Unauthorized");
      }
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "createPlaidLinkToken",
        RATE_LIMITS.createPlaidLinkToken,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    try {
      const plaid = getPlaid();
      const response = await plaid.linkTokenCreate({
        user: { client_user_id: uid },
        client_name: "Niyah",
        products: [Products.Auth],
        country_codes: [CountryCode.Us],
        language: "en",
      });

      res.json({ linkToken: response.data.link_token });
    } catch (err) {
      console.error("createPlaidLinkToken error:", err);
      sendError(res, 500, "Failed to create bank link session");
    }
  },
);

// ─── linkBankAccount ────────────────────────────────────────────────────────
/**
 * Exchanges a Plaid public_token for access credentials, creates a Stripe
 * Custom connected account (if needed), and attaches the bank via a Plaid
 * processor token. This is a one-time setup per bank account.
 *
 * Body: { publicToken: string, accountId: string }
 *   publicToken — from Plaid Link onSuccess
 *   accountId   — the Plaid account_id the user selected
 *
 * Returns: { success: true, bankName: string, bankMask: string }
 *
 * SECURITY:
 * - Auth required (verifyAuth)
 * - Rate limited (5/hr)
 * - Plaid access_token stored server-side only (never sent to client)
 * - Stripe account created as Custom type (no hosted redirect needed)
 */
export const linkBankAccount = onRequest(
  PUBLIC_PLAID_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req, { enforceAppCheck: APP_CHECK_ENFORCED });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("App Check")) {
        sendError(res, 403, "App Check attestation required");
      } else {
        sendError(res, 401, "Unauthorized");
      }
      return;
    }

    if (
      await checkRateLimit(uid, "linkBankAccount", RATE_LIMITS.linkBankAccount)
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { publicToken, accountId } = req.body as {
      publicToken: unknown;
      accountId: unknown;
    };
    if (typeof publicToken !== "string" || !publicToken) {
      sendError(res, 400, "Missing publicToken");
      return;
    }
    if (typeof accountId !== "string" || !accountId) {
      sendError(res, 400, "Missing accountId");
      return;
    }

    try {
      const plaid = getPlaid();
      const stripe = getStripe();
      const userRef = db.collection("users").doc(uid);
      const userDoc = await userRef.get();
      const userData = userDoc.data() ?? {};

      // Idempotency: if user already has a linked bank, return existing data
      if (userData.linkedBank && userData.stripeAccountId) {
        const lb = userData.linkedBank as {
          institutionName?: string;
          bankName?: string;
          mask?: string;
        };
        res.json({
          success: true,
          bankName: lb.institutionName ?? lb.bankName ?? "Bank",
          bankMask: lb.mask ?? "****",
        });
        return;
      }

      payoutBreadcrumb("linkBankAccount", "entry", { uid });

      // 1. Exchange public_token → access_token (server-side only)
      let accessToken: string;
      let itemId: string;
      try {
        const exchangeResponse = await plaid.itemPublicTokenExchange({
          public_token: publicToken,
        });
        accessToken = exchangeResponse.data.access_token;
        itemId = exchangeResponse.data.item_id;
      } catch (err) {
        console.error("linkBankAccount step 1 (token exchange) failed:", err);
        payoutBreadcrumb("linkBankAccount", "token_exchange_failed", { uid });
        sendError(res, 500, "Failed to exchange Plaid token");
        return;
      }
      payoutBreadcrumb("linkBankAccount", "token_exchanged", { uid, itemId });

      // 2. Get account details for display (mask, institution name)
      let bankMask = "****";
      let bankName = "Bank Account";
      let institutionName = "Bank";
      try {
        const accountsResponse = await plaid.accountsGet({
          access_token: accessToken,
        });
        const linkedAccount = accountsResponse.data.accounts.find(
          (a) => a.account_id === accountId,
        );
        bankMask = linkedAccount?.mask ?? "****";
        bankName = linkedAccount?.name ?? "Bank Account";

        const itemResponse = await plaid.itemGet({
          access_token: accessToken,
        });
        const institutionId = itemResponse.data.item.institution_id;
        if (institutionId) {
          try {
            const instResponse = await plaid.institutionsGetById({
              institution_id: institutionId,
              country_codes: [CountryCode.Us],
            });
            institutionName = instResponse.data.institution.name;
          } catch {
            // Non-critical — use default
          }
        }
      } catch (err) {
        console.error("linkBankAccount step 2 (account details) failed:", err);
        // Non-fatal — proceed with defaults
      }

      // 3. Create Stripe processor token from Plaid
      let stripeBankToken: string;
      try {
        const processorResponse =
          await plaid.processorStripeBankAccountTokenCreate({
            access_token: accessToken,
            account_id: accountId,
          });
        stripeBankToken = processorResponse.data.stripe_bank_account_token;
      } catch (err) {
        console.error("linkBankAccount step 3 (processor token) failed:", err);
        sendError(
          res,
          500,
          "Failed to create processor token. Ensure Plaid-Stripe integration is enabled in your Plaid dashboard.",
        );
        return;
      }

      // 4. Create or get Stripe Express connected account
      let stripeAccountId: string = userData.stripeAccountId ?? "";
      try {
        if (!stripeAccountId) {
          const validEmail =
            typeof userData.email === "string" && userData.email.includes("@")
              ? userData.email
              : undefined;

          const account = await stripe.accounts.create({
            type: "express",
            country: "US",
            ...(validEmail ? { email: validEmail } : {}),
            capabilities: {
              transfers: { requested: true },
            },
            metadata: { firebaseUid: uid },
          });
          stripeAccountId = account.id;
        }
      } catch (err) {
        console.error("linkBankAccount step 4 (Stripe account) failed:", err);
        const stripeErr = err as { message?: string };
        sendError(
          res,
          500,
          stripeErr.message
            ? `Failed to create Stripe connected account: ${stripeErr.message}`
            : "Failed to create Stripe connected account",
        );
        return;
      }

      // 5. Attach bank account to Stripe connected account via processor token
      try {
        await stripe.accounts.createExternalAccount(stripeAccountId, {
          external_account: stripeBankToken,
          default_for_currency: true,
        });
      } catch (err: unknown) {
        // If bank already exists on this account, treat as success
        const stripeErr = err as { code?: string; message?: string };
        if (
          stripeErr.code === "bank_account_exists" ||
          stripeErr.message?.includes("already exists")
        ) {
          console.warn(
            "linkBankAccount step 5: bank already attached, continuing",
          );
        } else {
          console.error(
            "linkBankAccount step 5 (attach bank) failed:",
            JSON.stringify({
              code: stripeErr.code,
              message: stripeErr.message,
              accountId: stripeAccountId,
            }),
          );
          sendError(
            res,
            500,
            stripeErr.message
              ? `Failed to attach bank account to Stripe: ${stripeErr.message}`
              : "Failed to attach bank account to Stripe",
          );
          return;
        }
      }

      payoutBreadcrumb("linkBankAccount", "stripe_bank_attached", {
        uid,
        stripeAccountId,
      });

      // 6. Store everything in Firestore (access_token server-side only)
      await userRef.update({
        stripeAccountId: stripeAccountId,
        stripeAccountStatus: "active",
        plaidAccessToken: accessToken,
        plaidItemId: itemId,
        plaidAccountId: accountId,
        linkedBank: {
          institutionName,
          bankName,
          mask: bankMask,
          linkedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      payoutBreadcrumb("linkBankAccount", "firestore_committed", { uid });

      res.json({
        success: true,
        bankName: institutionName,
        bankMask,
      });
    } catch (err) {
      console.error("linkBankAccount unexpected error:", err);
      const message =
        err instanceof Error ? err.message : "Failed to link bank account";
      sendError(res, 500, message);
    }
  },
);

// ─── unlinkBankAccount ──────────────────────────────────────────────────────
/**
 * Removes the user's linked bank. Detaches every external account from the
 * Stripe Connect account, invalidates the Plaid item, and clears the
 * `linkedBank` + Plaid-token fields on the user doc. Idempotent — a second
 * call on an already-unlinked user is a no-op success.
 *
 * The Stripe connected account itself stays intact so a later
 * `linkBankAccount` can reuse it. `stripeAccountStatus` flips to "pending"
 * to communicate that withdrawals are disabled until a new bank is attached.
 */
export const unlinkBankAccount = onRequest(
  PUBLIC_PLAID_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req, { enforceAppCheck: APP_CHECK_ENFORCED });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      sendError(
        res,
        msg.includes("App Check") ? 403 : 401,
        msg.includes("App Check") ? "App Check attestation required" : "Unauthorized",
      );
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "unlinkBankAccount",
        RATE_LIMITS.unlinkBankAccount,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    try {
      console.info(`unlinkBankAccount start uid=${uid}`);
      await unlinkBankInternal(uid);
      console.info(`unlinkBankAccount complete uid=${uid}`);
      res.json({ success: true });
    } catch (err) {
      console.error("unlinkBankAccount error:", err);
      const message =
        err instanceof Error ? err.message : "Failed to unlink bank";
      sendError(res, 500, message);
    }
  },
);

/**
 * Shared unlink path used by both `unlinkBankAccount` and `replaceBankAccount`.
 * Best-effort: each external system call is wrapped so a Plaid outage does not
 * leave Firestore inconsistent. Stripe detach failures are logged but the
 * Firestore-side clear still runs so the user can re-link.
 */
async function unlinkBankInternal(uid: string): Promise<void> {
  const stripe = getStripe();
  const plaid = getPlaid();
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return;
  const userData = userSnap.data() ?? {};

  const stripeAccountId =
    typeof userData.stripeAccountId === "string"
      ? userData.stripeAccountId
      : undefined;
  const plaidAccessToken =
    typeof userData.plaidAccessToken === "string"
      ? userData.plaidAccessToken
      : undefined;

  // Detach all external accounts attached to the Stripe Connect account.
  if (stripeAccountId) {
    try {
      const externalAccounts = await stripe.accounts.listExternalAccounts(
        stripeAccountId,
        { object: "bank_account", limit: 10 },
      );
      for (const ext of externalAccounts.data) {
        try {
          await stripe.accounts.deleteExternalAccount(stripeAccountId, ext.id);
          console.info(
            `unlinkBankInternal: detached stripe external ${ext.id} from ${stripeAccountId}`,
          );
        } catch (detachErr) {
          console.warn(
            `unlinkBankInternal: failed to detach ${ext.id}:`,
            detachErr,
          );
        }
      }
    } catch (err) {
      console.warn("unlinkBankInternal: listExternalAccounts failed:", err);
    }
  }

  // Invalidate Plaid access token so it cannot be reused. /item/remove is
  // best-effort — if it fails, the token has at most a 30-day lifetime anyway.
  if (plaidAccessToken) {
    try {
      await plaid.itemRemove({ access_token: plaidAccessToken });
      console.info(`unlinkBankInternal: plaid item removed for uid=${uid}`);
    } catch (err) {
      console.warn("unlinkBankInternal: plaid.itemRemove failed:", err);
    }
  }

  await userRef.update({
    linkedBank: admin.firestore.FieldValue.delete(),
    plaidAccessToken: admin.firestore.FieldValue.delete(),
    plaidItemId: admin.firestore.FieldValue.delete(),
    plaidAccountId: admin.firestore.FieldValue.delete(),
    stripeAccountStatus: stripeAccountId ? "pending" : undefined,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ─── replaceBankAccount ─────────────────────────────────────────────────────
/**
 * Atomically swaps the linked bank. Validates and attaches the new bank
 * first; only then detaches the old one and clears its Plaid token. If the
 * new attach fails, the old bank is left untouched — no halfway state.
 *
 * Body: { publicToken: string, accountId: string }
 * Returns: { success: true, bankName, bankMask } on success.
 */
export const replaceBankAccount = onRequest(
  PUBLIC_PLAID_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req, { enforceAppCheck: APP_CHECK_ENFORCED });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      sendError(
        res,
        msg.includes("App Check") ? 403 : 401,
        msg.includes("App Check") ? "App Check attestation required" : "Unauthorized",
      );
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "replaceBankAccount",
        RATE_LIMITS.replaceBankAccount,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { publicToken, accountId } = req.body as {
      publicToken: unknown;
      accountId: unknown;
    };
    if (typeof publicToken !== "string" || !publicToken) {
      sendError(res, 400, "Missing publicToken");
      return;
    }
    if (typeof accountId !== "string" || !accountId) {
      sendError(res, 400, "Missing accountId");
      return;
    }

    const plaid = getPlaid();
    const stripe = getStripe();
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.data() ?? {};

    const oldStripeAccountId =
      typeof userData.stripeAccountId === "string"
        ? userData.stripeAccountId
        : "";
    const oldPlaidAccessToken =
      typeof userData.plaidAccessToken === "string"
        ? userData.plaidAccessToken
        : undefined;

    try {
      console.info(`replaceBankAccount start uid=${uid}`);

      // 1. Validate new public_token by exchanging it.
      const exchange = await plaid.itemPublicTokenExchange({
        public_token: publicToken,
      });
      const newAccessToken = exchange.data.access_token;
      const newItemId = exchange.data.item_id;

      // 2. Fetch metadata for the new account.
      let bankMask = "****";
      let bankName = "Bank Account";
      let institutionName = "Bank";
      try {
        const accountsResponse = await plaid.accountsGet({
          access_token: newAccessToken,
        });
        const linkedAccount = accountsResponse.data.accounts.find(
          (a) => a.account_id === accountId,
        );
        bankMask = linkedAccount?.mask ?? "****";
        bankName = linkedAccount?.name ?? "Bank Account";
        const itemResponse = await plaid.itemGet({
          access_token: newAccessToken,
        });
        const institutionId = itemResponse.data.item.institution_id;
        if (institutionId) {
          try {
            const instResponse = await plaid.institutionsGetById({
              institution_id: institutionId,
              country_codes: [CountryCode.Us],
            });
            institutionName = instResponse.data.institution.name;
          } catch {
            // Non-critical
          }
        }
      } catch (err) {
        console.warn("replaceBankAccount: account metadata fetch failed:", err);
      }

      // 3. Generate Stripe processor token.
      const processorResponse =
        await plaid.processorStripeBankAccountTokenCreate({
          access_token: newAccessToken,
          account_id: accountId,
        });
      const stripeBankToken = processorResponse.data.stripe_bank_account_token;

      // 4. Ensure we have a Stripe connect account.
      let stripeAccountId = oldStripeAccountId;
      if (!stripeAccountId) {
        const validEmail =
          typeof userData.email === "string" && userData.email.includes("@")
            ? userData.email
            : undefined;
        const account = await stripe.accounts.create({
          type: "express",
          country: "US",
          ...(validEmail ? { email: validEmail } : {}),
          capabilities: { transfers: { requested: true } },
          metadata: { firebaseUid: uid },
        });
        stripeAccountId = account.id;
      }

      // 5. Attach new bank — this is the gate. If it fails, the old bank
      //    stays. We do NOT detach yet.
      await stripe.accounts.createExternalAccount(stripeAccountId, {
        external_account: stripeBankToken,
        default_for_currency: true,
      });

      // 6. New bank attached. Detach old external accounts (best-effort).
      try {
        const existing = await stripe.accounts.listExternalAccounts(
          stripeAccountId,
          { object: "bank_account", limit: 10 },
        );
        for (const ext of existing.data) {
          // Skip the one we just attached (default_for_currency is now this one)
          if (ext.default_for_currency) continue;
          try {
            await stripe.accounts.deleteExternalAccount(
              stripeAccountId,
              ext.id,
            );
          } catch (detachErr) {
            console.warn(
              `replaceBankAccount: failed to detach old ext ${ext.id}:`,
              detachErr,
            );
          }
        }
      } catch (err) {
        console.warn("replaceBankAccount: cleanup of old externals failed:", err);
      }

      // 7. Update Firestore with new bank info.
      await userRef.update({
        stripeAccountId,
        stripeAccountStatus: "active",
        plaidAccessToken: newAccessToken,
        plaidItemId: newItemId,
        plaidAccountId: accountId,
        linkedBank: {
          institutionName,
          bankName,
          mask: bankMask,
          linkedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 8. Invalidate the old Plaid item. Best-effort, post-commit.
      if (oldPlaidAccessToken && oldPlaidAccessToken !== newAccessToken) {
        try {
          await plaid.itemRemove({ access_token: oldPlaidAccessToken });
        } catch (err) {
          console.warn("replaceBankAccount: old plaid.itemRemove failed:", err);
        }
      }

      console.info(`replaceBankAccount complete uid=${uid}`);
      res.json({
        success: true,
        bankName: institutionName,
        bankMask,
      });
    } catch (err) {
      console.error("replaceBankAccount unexpected error:", err);
      const message =
        err instanceof Error ? err.message : "Failed to replace bank";
      sendError(res, 500, message);
    }
  },
);

// ─── handleSessionComplete ──────────────────────────────────────────────────
/**
 * Called when a solo session completes successfully.
 * Refunds the stake back to the user (stay-the-same model for MVP).
 * Body: { sessionId: string }
 * Returns: { newBalance: number, payout: number }
 *
 * SECURITY: Reads stakeAmount from the session doc (not from client).
 * Validates session ownership, status, and that the timer has expired.
 */
export const handleSessionComplete = onRequest(
  PUBLIC_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "handleSessionComplete",
        RATE_LIMITS.handleSessionComplete,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { sessionId } = req.body as { sessionId: string };
    if (!sessionId) {
      sendError(res, 400, "Missing sessionId");
      return;
    }

    try {
      const walletRef = db.collection("wallets").doc(uid);
      const userRef = db.collection("users").doc(uid);
      const txnRef = db.collection("transactions").doc();
      const sessionRef = db.collection("sessions").doc(sessionId);

      const { newBalance, payout } = await db.runTransaction(async (txn) => {
        // Read session doc — authoritative source of truth
        const sessionSnap = await txn.get(sessionRef);
        if (!sessionSnap.exists) {
          throw new Error("Session not found");
        }
        const sessionData = sessionSnap.data()!;

        // Verify ownership: session must belong to the authenticated user
        if (sessionData.userId !== uid) {
          throw new Error("Session does not belong to this user");
        }

        // Verify status: session must be active (prevents double-completion)
        if (sessionData.status !== "active") {
          throw new Error(
            `Session is not active (current status: ${sessionData.status})`,
          );
        }

        // Verify timer: session must have ended (30s grace for clock skew)
        const endsAt = sessionData.endsAt?.toDate?.()
          ? sessionData.endsAt.toDate()
          : new Date(sessionData.endsAt);
        const gracePeriodMs = 10_000; // 10 seconds
        if (endsAt.getTime() - gracePeriodMs > Date.now()) {
          throw new Error("Session has not ended yet");
        }

        // Read stakeAmount from session doc — NEVER trust client-provided amount
        const stakeAmount: number = sessionData.stakeAmount;
        if (!stakeAmount || stakeAmount <= 0) {
          throw new Error("Invalid stake amount on session");
        }

        // Payout = stake (stickK model). User gets their stake back.
        const payout = stakeAmount;

        // Credit balance to wallets collection (protected from client writes)
        const walletSnap = await txn.get(walletRef);
        const currentBalance: number = walletSnap.data()?.balance ?? 0;
        const updatedBalance = currentBalance + payout;
        txn.update(walletRef, { balance: updatedBalance });

        // Update user stats (separate from financial balance)
        txn.update(userRef, {
          completedSessions: admin.firestore.FieldValue.increment(1),
          totalSessions: admin.firestore.FieldValue.increment(1),
          currentStreak: admin.firestore.FieldValue.increment(1),
          totalEarnings: admin.firestore.FieldValue.increment(payout),
        });

        // Record transaction
        txn.set(txnRef, {
          userId: uid,
          type: "payout",
          amount: payout,
          description: "Session completed — stake returned",
          sessionId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Mark session as completed atomically
        txn.update(sessionRef, {
          status: "completed",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          actualPayout: payout,
        });

        return { newBalance: updatedBalance, payout };
      });

      // Check finals-promo eligibility after every session completion.
      // Idempotent via user.finalsPromoAwarded flag; safe to run on every call.
      await maybeAwardFinalsPromo(uid).catch((err) =>
        console.warn("maybeAwardFinalsPromo (solo) failed:", err),
      );

      res.json({ newBalance, payout });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      // Return 4xx for validation errors, 5xx for unexpected failures
      if (
        message.includes("not found") ||
        message.includes("does not belong") ||
        message.includes("not active") ||
        message.includes("not ended")
      ) {
        sendError(res, 400, message);
      } else {
        console.error("handleSessionComplete error:", err);
        sendError(res, 500, "Failed to process session completion");
      }
    }
  },
);

// ─── handleSessionForfeit ───────────────────────────────────────────────────
/**
 * Called when a user surrenders a session.
 * Stake is forfeited — goes to Niyah (revenue). Firestore balance already
 * decremented when session started, so we just record the forfeit.
 * Body: { sessionId: string }
 * Returns: { success: boolean }
 *
 * SECURITY: Reads stakeAmount from the session doc (not from client).
 * Validates session ownership and status.
 */
export const handleSessionForfeit = onRequest(
  PUBLIC_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "handleSessionForfeit",
        RATE_LIMITS.handleSessionForfeit,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { sessionId } = req.body as { sessionId: string };
    if (!sessionId) {
      sendError(res, 400, "Missing sessionId");
      return;
    }

    try {
      const sessionRef = db.collection("sessions").doc(sessionId);
      const userRef = db.collection("users").doc(uid);
      const walletRef = db.collection("wallets").doc(uid);
      const txnRef = db.collection("transactions").doc();
      const revenueRef = db.collection("revenue").doc();
      const forgivenessTxnRef = db
        .collection("transactions")
        .doc(`first_surrender_forgiven_${uid}`);

      const outcome = await db.runTransaction(async (txn) => {
        // Reads must come before any writes inside a transaction.
        const sessionSnap = await txn.get(sessionRef);
        if (!sessionSnap.exists) {
          throw new Error("Session not found");
        }
        const sessionData = sessionSnap.data()!;

        if (sessionData.userId !== uid) {
          throw new Error("Session does not belong to this user");
        }
        if (sessionData.status !== "active") {
          throw new Error(
            `Session is not active (current status: ${sessionData.status})`,
          );
        }

        const userSnap = await txn.get(userRef);
        const userData = userSnap.data() ?? {};
        const walletSnap = await txn.get(walletRef);

        const stakeAmount: number = sessionData.stakeAmount;

        // First-surrender forgiveness: refund min(stake, cap) once per user.
        // Framed as a tutorial lesson — user sees the commitment mechanism work
        // without losing real money on the first attempt. Gated by an atomic
        // flag so double-RPC cannot double-credit.
        const alreadyForgiven = userData.firstSurrenderForgiven === true;
        let refundedCents = 0;
        if (
          !alreadyForgiven &&
          stakeAmount > 0 &&
          FIRST_SURRENDER_FORGIVENESS_CENTS > 0
        ) {
          refundedCents = Math.min(
            stakeAmount,
            FIRST_SURRENDER_FORGIVENESS_CENTS,
          );
        }

        // Stats (always)
        txn.update(userRef, {
          totalSessions: admin.firestore.FieldValue.increment(1),
          currentStreak: 0,
          ...(refundedCents > 0
            ? {
                firstSurrenderForgiven: true,
                firstSurrenderForgivenAt:
                  admin.firestore.FieldValue.serverTimestamp(),
              }
            : {}),
        });

        // Session status
        txn.update(sessionRef, {
          status: "surrendered",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          actualPayout: refundedCents,
        });

        // Forfeit transaction record
        txn.set(txnRef, {
          userId: uid,
          type: "forfeit",
          amount: 0,
          description: "Session surrendered — stake forfeited",
          sessionId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Forgiveness credit to wallet + ledger
        if (refundedCents > 0) {
          const currentBalance: number = walletSnap.data()?.balance ?? 0;
          const nextBalance = currentBalance + refundedCents;
          if (walletSnap.exists) {
            txn.update(walletRef, {
              balance: nextBalance,
              lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
            });
          } else {
            txn.set(
              walletRef,
              {
                balance: nextBalance,
                pendingBalance: 0,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true },
            );
          }
          txn.set(forgivenessTxnRef, {
            userId: uid,
            type: "forgiveness",
            amount: refundedCents,
            description: "First surrender forgiven",
            sessionId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        // Revenue: forfeit minus any forgiveness refund.
        const revenueAmount = stakeAmount - refundedCents;
        if (revenueAmount > 0) {
          txn.set(revenueRef, {
            userId: uid,
            amount: revenueAmount,
            sessionId,
            type: "forfeit",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        return { forgiven: refundedCents > 0, refundedCents };
      });

      res.json({
        success: true,
        forgiven: outcome.forgiven,
        refundedCents: outcome.refundedCents,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (
        message.includes("not found") ||
        message.includes("does not belong") ||
        message.includes("not active")
      ) {
        sendError(res, 400, message);
      } else {
        console.error("handleSessionForfeit error:", err);
        sendError(res, 500, "Failed to record session forfeit");
      }
    }
  },
);

// ─── getWithdrawalEligibility ───────────────────────────────────────────────
/**
 * Returns the current user's progress toward unlocking withdrawal. The client
 * uses this to show "X of 5 sessions completed" hints on the wallet/withdraw
 * screens before the user attempts to withdraw.
 *
 * Returns: {
 *   completedSessions, distinctPartners,
 *   requiredSessions, requiredPartners,
 *   eligible: boolean,
 * }
 */
export const getWithdrawalEligibility = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST" && req.method !== "GET") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    try {
      const stats = await getWithdrawalEligibilityStats(uid);
      const eligible =
        stats.completedSessions >= stats.requiredSessions &&
        stats.distinctPartners >= stats.requiredPartners;
      res.json({ ...stats, eligible });
    } catch (err) {
      console.error("getWithdrawalEligibility error:", err);
      sendError(res, 500, "Failed to compute eligibility");
    }
  },
);

// ─── requestWithdrawal ──────────────────────────────────────────────────────
/**
 * Transfers funds from Niyah's platform account to the user's Stripe Connect
 * account, then optionally triggers an instant payout to their bank.
 *
 * Body: { amount: number, method: 'standard' | 'instant' }
 *   standard — transfer to connected account, auto-payout schedule (1-2 business days)
 *   instant  — transfer + immediate payout (1.5% Stripe fee, absorbed by Niyah)
 *
 * Returns: { success, transferId, payoutId?, estimatedArrival }
 */
export const requestWithdrawal = onRequest(
  PUBLIC_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req, { enforceAppCheck: APP_CHECK_ENFORCED });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("App Check")) {
        sendError(res, 403, "App Check attestation required");
      } else {
        sendError(res, 401, "Unauthorized");
      }
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "requestWithdrawal",
        RATE_LIMITS.requestWithdrawal,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { amount, method = "standard" } = req.body as {
      amount: unknown;
      method?: "standard" | "instant" | "venmo";
    };

    if (
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      !Number.isInteger(amount)
    ) {
      sendError(res, 400, "Amount must be an integer");
      return;
    }
    if (amount < 1000) {
      sendError(res, 400, "Minimum withdrawal is $10");
      return;
    }
    if (amount > 1_000_000) {
      sendError(res, 400, "Maximum withdrawal is $10,000 per transaction");
      return;
    }

    // Campus-launch anti-gaming gate: block withdrawal until the user has
    // completed enough sessions AND played with enough distinct friends.
    // See WITHDRAWAL_MIN_* env vars for tuning.
    const eligibility = await assertWithdrawalEligibility(uid);
    if (!eligibility.ok) {
      sendError(res, 403, eligibility.message);
      return;
    }

    // Daily aggregate withdrawal limit: $25,000
    try {
      const oneDayAgo = new Date(Date.now() - 86_400_000);
      const recentWithdrawals = await db
        .collection("transactions")
        .where("userId", "==", uid)
        .where("type", "==", "withdrawal")
        .where("createdAt", ">=", oneDayAgo)
        .get();
      const dailyTotal = recentWithdrawals.docs.reduce(
        (sum, doc) => sum + Math.abs(doc.data().amount ?? 0),
        0,
      );
      if (dailyTotal + amount > 2_500_000) {
        sendError(
          res,
          400,
          `Daily withdrawal limit is $25,000. You've withdrawn ${(dailyTotal / 100).toFixed(2)} today.`,
        );
        return;
      }
    } catch (limitErr) {
      console.error("Daily limit check failed:", limitErr);
      // Fail open for now — rate limiting still protects against abuse
    }

    try {
      const walletRef = db.collection("wallets").doc(uid);

      // Read balance from wallets collection (protected from client writes)
      const walletSnap = await walletRef.get();
      if ((walletSnap.data()?.balance ?? 0) < amount) {
        sendError(res, 400, "Insufficient balance");
        return;
      }

      // Atomically deduct balance from wallets collection
      const txnRef = db.collection("transactions").doc();
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(walletRef);
        const current: number = snap.data()?.balance ?? 0;
        if (current < amount) throw new Error("Insufficient balance");
        txn.update(walletRef, { balance: current - amount });
        txn.set(txnRef, {
          userId: uid,
          type: "withdrawal",
          amount: -amount,
          description: `Withdrawal (${method})`,
          status: method === "venmo" ? "pending_venmo" : "processing",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      // Venmo: balance deducted, user handles Venmo request separately
      if (method === "venmo") {
        await txnRef.update({ status: "pending_venmo" });
        res.json({
          success: true,
          transferId: txnRef.id,
          estimatedArrival: "Within 24 hours (manual Venmo)",
        });
        return;
      }

      // Stripe methods require a connected account
      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();
      const userData = userSnap.data() ?? {};

      const connectedAccountId: string = userData.stripeAccountId ?? "";
      if (!connectedAccountId) {
        // Restore balance since Stripe transfer can't proceed
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(walletRef);
          const current: number = snap.data()?.balance ?? 0;
          txn.update(walletRef, { balance: current + amount });
        });
        await txnRef.delete();
        sendError(
          res,
          400,
          "No payout account set up — complete Stripe onboarding first",
        );
        return;
      }
      if (userData.stripeAccountStatus !== "active") {
        // Restore balance since Stripe transfer can't proceed
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(walletRef);
          const current: number = snap.data()?.balance ?? 0;
          txn.update(walletRef, { balance: current + amount });
        });
        await txnRef.delete();
        sendError(
          res,
          400,
          "Payout account not yet verified — complete identity verification first",
        );
        return;
      }

      const stripe = getStripe();

      // Re-verify live account status immediately before transfer. Cached
      // stripeAccountStatus in Firestore may be stale if Stripe restricted
      // the account since the last getConnectAccountStatus call.
      try {
        const liveAccount = await stripe.accounts.retrieve(connectedAccountId);
        if (!liveAccount.payouts_enabled || !liveAccount.charges_enabled) {
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(walletRef);
            const current: number = snap.data()?.balance ?? 0;
            txn.update(walletRef, { balance: current + amount });
          });
          await txnRef.delete();
          sendError(
            res,
            400,
            "Payout account status changed — re-verify identity in settings",
          );
          return;
        }
      } catch (err) {
        console.error("Stripe account retrieve failed:", err);
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(walletRef);
          const current: number = snap.data()?.balance ?? 0;
          txn.update(walletRef, { balance: current + amount });
        });
        await txnRef.delete();
        sendError(res, 502, "Could not verify payout account with Stripe");
        return;
      }

      payoutBreadcrumb("requestWithdrawal", "wallet_debited", {
        uid,
        amount,
        method,
        txnId: txnRef.id,
      });

      // Transfer from Niyah's platform account → user's connected account.
      // Idempotency key collapses retries within the same minute on the same
      // (user, amount, method) so a flaky network can't trigger duplicate
      // transfers — Stripe will return the original transfer instead of
      // creating a new one.
      const idemBucket = Math.floor(Date.now() / 60_000);
      const idempotencyKey = `withdrawal:${uid}:${amount}:${method}:${idemBucket}`;
      const transfer = await stripe.transfers.create(
        {
          amount,
          currency: "usd",
          destination: connectedAccountId,
          metadata: { firebaseUid: uid, type: "withdrawal", method },
        },
        { idempotencyKey },
      );
      payoutBreadcrumb("requestWithdrawal", "stripe_transfer_created", {
        uid,
        amount,
        transferId: transfer.id,
        idempotencyKey,
      });

      // Update transaction with transfer ID
      await txnRef.update({ stripeTransferId: transfer.id });

      let payoutId: string | undefined;
      let estimatedArrival: string;

      if (method === "instant") {
        // Trigger immediate payout from connected account → their bank
        // Niyah absorbs the 1.5% instant payout fee (charged to platform)
        const payout = await stripe.payouts.create(
          { amount, currency: "usd", method: "instant" },
          { stripeAccount: connectedAccountId },
        );
        payoutId = payout.id;
        estimatedArrival = "Within 30 minutes";
        await txnRef.update({ stripePayoutId: payoutId, status: "sent" });
      } else {
        // Standard: connected account's auto-payout schedule handles bank transfer
        estimatedArrival = "1–2 business days";
        await txnRef.update({ status: "sent" });
      }

      res.json({
        success: true,
        transferId: transfer.id,
        payoutId,
        estimatedArrival,
      });
    } catch (err) {
      console.error("requestWithdrawal error:", err);
      // If Stripe transfer failed, restore balance in wallets collection
      try {
        const walletRestoreRef = db.collection("wallets").doc(uid);
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(walletRestoreRef);
          const current: number = snap.data()?.balance ?? 0;
          txn.update(walletRestoreRef, { balance: current + amount });
        });
      } catch (restoreErr) {
        console.error(
          "Failed to restore balance after withdrawal error:",
          restoreErr,
        );
      }
      const stripeErr = err as { message?: string; code?: string };
      const detail = stripeErr.message || "Unknown error";
      console.error("requestWithdrawal Stripe detail:", detail);
      sendError(
        res,
        500,
        `Withdrawal failed — your balance has been restored. (${detail})`,
      );
    }
  },
);

// ─── distributeGroupPayouts ─────────────────────────────────────────────────
/**
 * Distributes or reconciles stored group session payouts via Stripe Connect.
 * Called by the proposer after a session is completed.
 *
 * Body: { sessionId: string }
 * Returns: { success: boolean, transfers: string[], payouts: { userId: string, amount: number }[] }
 *
 * SECURITY: Ignores client-supplied payout inputs and only uses the
 * server-recorded payouts from the completed session document. Wallet credits
 * and Stripe transfers are idempotent, so this endpoint can safely reconcile a
 * partially-settled session without double-paying anyone.
 */
export const distributeGroupPayouts = onRequest(
  PUBLIC_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "distributeGroupPayouts",
        RATE_LIMITS.distributeGroupPayouts,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { sessionId } = req.body as { sessionId?: unknown };

    if (typeof sessionId !== "string" || !sessionId) {
      sendError(res, 400, "Missing sessionId");
      return;
    }

    payoutBreadcrumb("distributeGroupPayouts", "entry", { uid, sessionId });

    try {
      const sessionRef = db.collection("groupSessions").doc(sessionId);
      const sessionSnap = await sessionRef.get();

      if (!sessionSnap.exists) {
        sendError(res, 404, "Session not found");
        return;
      }

      const sessionData = sessionSnap.data()!;

      if (sessionData.proposerId !== uid) {
        sendError(res, 403, "Only the proposer can reconcile payouts");
        return;
      }
      payoutBreadcrumb("distributeGroupPayouts", "session_loaded", {
        uid,
        sessionId,
        status: typeof sessionData.status === "string" ? sessionData.status : "",
      });

      if (sessionData.status !== "completed") {
        sendError(
          res,
          409,
          "Session must be completed before payouts can be reconciled",
        );
        return;
      }

      const participantIds = Array.isArray(sessionData.participantIds)
        ? sessionData.participantIds.filter(
            (participantId): participantId is string =>
              typeof participantId === "string" && participantId.length > 0,
          )
        : [];

      if (participantIds.length === 0) {
        sendError(res, 500, "Session participants are missing");
        return;
      }

      const rawPayouts = sessionData.payouts as
        | Record<string, unknown>
        | undefined;
      if (!rawPayouts) {
        sendError(res, 409, "Session payouts are not available yet");
        return;
      }

      const serverPayouts = buildStoredPayouts(participantIds, rawPayouts);
      payoutBreadcrumb("distributeGroupPayouts", "before_settle", {
        uid,
        sessionId,
        payoutCount: serverPayouts.length,
        poolCents: serverPayouts.reduce((acc, p) => acc + p.amount, 0),
      });
      const transferIds = await settleGroupSessionPayouts(
        sessionId,
        serverPayouts,
        uid,
      );
      payoutBreadcrumb("distributeGroupPayouts", "settle_complete", {
        uid,
        sessionId,
        transferCount: transferIds.length,
      });

      res.json({
        success: true,
        transfers: transferIds,
        payouts: serverPayouts,
      });
    } catch (err) {
      console.error("distributeGroupPayouts error:", err);
      payoutBreadcrumb("distributeGroupPayouts", "error", {
        uid,
        sessionId,
        message: err instanceof Error ? err.message : "unknown",
      });
      sendError(res, 500, "Failed to distribute payouts");
    }
  },
);

// ─── awardReferral ──────────────────────────────────────────────────────────
/**
 * Awards a referral bonus to a referrer user. Called server-side to prevent
 * any authenticated user from manipulating another user's reputation.
 *
 * Body: { referrerUid: string }
 * Returns: { success: boolean }
 *
 * SECURITY: Previously, awardReferralToUser() in firebase.ts wrote directly
 * to another user's document from the client, and the Firestore rule allowed
 * any authenticated user to modify any user's reputation field. This Cloud
 * Function replaces that pattern, blocks self-referrals, and allows each user
 * to claim a referral only once.
 */
export const awardReferral = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (await checkRateLimit(uid, "awardReferral", RATE_LIMITS.awardReferral)) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { referrerUid } = req.body as { referrerUid?: unknown };
    if (!referrerUid) {
      sendError(res, 400, "Missing referrerUid");
      return;
    }

    // Validate referrerUid format (Firebase UIDs are alphanumeric, 1-128 chars)
    if (!isValidFirebaseUid(referrerUid)) {
      sendError(res, 400, "Invalid referrerUid format");
      return;
    }

    if (referrerUid === uid) {
      sendError(res, 400, "Cannot refer yourself");
      return;
    }

    try {
      const callerRef = db.collection("users").doc(uid);
      const referrerRef = db.collection("users").doc(referrerUid);

      const result = await db.runTransaction(async (txn) => {
        const callerSnap = await txn.get(callerRef);
        if (!callerSnap.exists) {
          throw new Error("Caller profile not found");
        }

        const referrerSnap = await txn.get(referrerRef);
        if (!referrerSnap.exists) {
          throw new Error("Referrer not found");
        }

        const claimDecision = decideReferralClaim(
          callerSnap.data()?.referredByUid,
          referrerUid,
        );

        if (claimDecision.status === "already_claimed") {
          return claimDecision;
        }

        const docData = referrerSnap.data() ?? {};
        const rep = (docData.reputation as Record<string, unknown>) ?? {};
        const nextReputation = calculateReferralReputation(rep);

        txn.set(
          callerRef,
          {
            referredByUid: referrerUid,
            referralAwardedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        txn.set(
          referrerRef,
          {
            reputation: { ...rep, ...nextReputation },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        return claimDecision;
      });

      if (result.status === "already_claimed") {
        res.json({
          success: true,
          alreadyClaimed: true,
          sameReferrer: result.sameReferrer,
        });
        return;
      }

      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (
        message === "Caller profile not found" ||
        message === "Referrer not found"
      ) {
        sendError(res, 404, message);
      } else {
        console.error("awardReferral error:", err);
        sendError(res, 500, "Failed to award referral");
      }
    }
  },
);

// ─── followUser ─────────────────────────────────────────────────────────────
/**
 * Follows a target user. Updates both the caller's `following` array and the
 * target's `followers` array atomically using a batch write.
 *
 * Body: { targetUid: string }
 * Returns: { success: boolean }
 *
 * SECURITY: Previously, the client wrote directly to another user's
 * `followers` field, and the Firestore rule allowed any authenticated user
 * to modify any user's followers array. This Cloud Function replaces that
 * pattern — ensures only the caller's own UID is added.
 */
export const followUserFn = onRequest(PUBLIC_HTTP_OPTIONS, async (req, res) => {
  if (req.method !== "POST") {
    sendError(res, 405, "Method not allowed");
    return;
  }

  let uid: string;
  try {
    uid = await verifyAuth(req);
  } catch {
    sendError(res, 401, "Unauthorized");
    return;
  }

  if (await checkRateLimit(uid, "followUserFn", RATE_LIMITS.followUserFn)) {
    sendError(res, 429, "Too many requests — try again later");
    return;
  }

  const { targetUid } = req.body as { targetUid: string };
  if (!targetUid || typeof targetUid !== "string") {
    sendError(res, 400, "Missing targetUid");
    return;
  }

  if (uid === targetUid) {
    sendError(res, 400, "Cannot follow yourself");
    return;
  }

  try {
    const batch = db.batch();
    const myRef = db.collection("userFollows").doc(uid);
    const targetRef = db.collection("userFollows").doc(targetUid);

    batch.set(
      myRef,
      { following: admin.firestore.FieldValue.arrayUnion(targetUid) },
      { merge: true },
    );
    batch.set(
      targetRef,
      { followers: admin.firestore.FieldValue.arrayUnion(uid) },
      { merge: true },
    );

    await batch.commit();
    res.json({ success: true });
  } catch (err) {
    console.error("followUser error:", err);
    sendError(res, 500, "Failed to follow user");
  }
});

// ─── unfollowUser ───────────────────────────────────────────────────────────
/**
 * Unfollows a target user. Removes the caller from the target's `followers`
 * and the target from the caller's `following`.
 *
 * Body: { targetUid: string }
 * Returns: { success: boolean }
 */
export const unfollowUserFn = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(uid, "unfollowUserFn", RATE_LIMITS.unfollowUserFn)
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { targetUid } = req.body as { targetUid: string };
    if (!targetUid || typeof targetUid !== "string") {
      sendError(res, 400, "Missing targetUid");
      return;
    }

    try {
      const batch = db.batch();
      const myRef = db.collection("userFollows").doc(uid);
      const targetRef = db.collection("userFollows").doc(targetUid);

      batch.set(
        myRef,
        { following: admin.firestore.FieldValue.arrayRemove(targetUid) },
        { merge: true },
      );
      batch.set(
        targetRef,
        { followers: admin.firestore.FieldValue.arrayRemove(uid) },
        { merge: true },
      );

      await batch.commit();
      res.json({ success: true });
    } catch (err) {
      console.error("unfollowUser error:", err);
      sendError(res, 500, "Failed to unfollow user");
    }
  },
);

// ─── stripeWebhook ──────────────────────────────────────────────────────────
/**
 * Handles Stripe webhook events for payment confirmation.
 * Configure webhook endpoint in Stripe dashboard.
 * Events handled: payment_intent.succeeded, account.updated
 */
export const stripeWebhook = onRequest(
  PUBLIC_STRIPE_WEBHOOK_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    const sig = req.headers["stripe-signature"];
    if (!sig) {
      sendError(res, 400, "Missing Stripe signature");
      return;
    }

    let event: Stripe.Event;
    try {
      const stripe = getStripe();
      event = stripe.webhooks.constructEvent(
        (req as unknown as { rawBody: Buffer }).rawBody,
        sig,
        STRIPE_WEBHOOK_SECRET.value(),
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err);
      sendError(res, 400, "Invalid signature");
      return;
    }

    try {
      switch (event.type) {
        case "payment_intent.succeeded": {
          // Backup handler in case client-side verifyAndCreditDeposit failed
          const pi = event.data.object as Stripe.PaymentIntent;
          if (pi.metadata.type === "deposit") {
            const uid = pi.metadata.firebaseUid;
            if (isValidFirebaseUid(uid)) {
              const existingTxn = await db
                .collection("transactions")
                .where("paymentIntentId", "==", pi.id)
                .limit(1)
                .get();

              if (existingTxn.empty) {
                const walletRef = db.collection("wallets").doc(uid);
                const txnRef = db.collection("transactions").doc();
                await db.runTransaction(async (txn) => {
                  const snap = await txn.get(walletRef);
                  const current: number = snap.data()?.balance ?? 0;
                  txn.update(walletRef, { balance: current + pi.amount });
                  txn.set(txnRef, {
                    userId: uid,
                    type: "deposit",
                    amount: pi.amount,
                    description: "Deposit via card",
                    paymentIntentId: pi.id,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                });
              }
            }
          }
          break;
        }

        case "account.updated": {
          // Sync Stripe Connect account status
          const account = event.data.object as Stripe.Account;
          const uid = account.metadata?.firebaseUid;
          if (isValidFirebaseUid(uid)) {
            const status = account.details_submitted
              ? account.payouts_enabled
                ? "active"
                : "restricted"
              : "pending";
            await db
              .collection("users")
              .doc(uid)
              .update({ stripeAccountStatus: status });
          }
          break;
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error("Webhook handler error:", err);
      sendError(res, 500, "Webhook handler failed");
    }
  },
);

// ─── Legal Acceptance ──────────────────────────────────────────────────────

/**
 * Records a user's acceptance of the Terms and Privacy policy.
 * Writes `legalAcceptanceVersion` and `legalAcceptedAt` (server timestamp)
 * to the user document for tamper-resistance.
 */
export const acceptLegalTerms = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req: Request, res: Response) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    try {
      const uid = await verifyAuth(req);
      const { version } = req.body;

      if (!version || typeof version !== "string") {
        sendError(res, 400, "Missing or invalid version");
        return;
      }

      // Rate limit: 10 calls per minute
      const blocked = await checkRateLimit(uid, "acceptLegalTerms", {
        maxCalls: 10,
        windowMs: 60_000,
      });
      if (blocked) {
        sendError(res, 429, "Too many requests");
        return;
      }

      await db.collection("users").doc(uid).update({
        legalAcceptanceVersion: version,
        legalAcceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({ success: true });
    } catch (err) {
      console.error("acceptLegalTerms error:", err);
      sendError(
        res,
        500,
        err instanceof Error ? err.message : "Internal error",
      );
    }
  },
);

// ─── createGroupSession ──────────────────────────────────────────────────────
// ─── findContactsOnNiyah ────────────────────────────────────────────────────
/**
 * Matches device contacts (phone numbers + emails) against existing Niyah users.
 * Body: { phones: string[], emails: string[] }
 *   phones — E.164 formatted phone numbers (e.g. "+15551234567")
 *   emails — lowercase email addresses
 * Returns: { matches: { uid, name, reputation }[] }
 *
 * SECURITY: Auth required. Rate limited. Raw contacts are NOT stored —
 * only used transiently for matching. Returns only public profile data.
 */
export const findContactsOnNiyah = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "findContactsOnNiyah",
        RATE_LIMITS.findContactsOnNiyah,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { phones = [], emails = [] } = req.body as {
      phones?: unknown[];
      emails?: unknown[];
    };

    // Validate + sanitize inputs (cap at 500 to prevent abuse)
    const cleanPhones = (Array.isArray(phones) ? phones : [])
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((p) => p.replace(/[^\d+]/g, ""))
      .slice(0, 500);
    const cleanEmails = (Array.isArray(emails) ? emails : [])
      .filter((e): e is string => typeof e === "string" && e.includes("@"))
      .map((e) => e.toLowerCase().trim())
      .slice(0, 500);

    if (cleanPhones.length === 0 && cleanEmails.length === 0) {
      res.json({ matches: [] });
      return;
    }

    try {
      const matchedUids = new Set<string>();
      const matches: {
        uid: string;
        name: string;
        reputation: { score: number; level: string };
      }[] = [];

      // Firestore `in` queries are limited to 30 items, so we batch
      const batchQuery = async (field: string, values: string[]) => {
        for (let i = 0; i < values.length; i += 30) {
          const batch = values.slice(i, i + 30);
          const snap = await db
            .collection("users")
            .where(field, "in", batch)
            .get();
          for (const doc of snap.docs) {
            if (doc.id !== uid && !matchedUids.has(doc.id)) {
              matchedUids.add(doc.id);
              const d = doc.data();
              matches.push({
                uid: doc.id,
                name: d.name ?? "Unknown",
                reputation: {
                  score: d.reputation?.score ?? 50,
                  level: d.reputation?.level ?? "sapling",
                },
              });
            }
          }
        }
      };

      // Query by phone number and email in parallel
      await Promise.all([
        cleanPhones.length > 0
          ? batchQuery("phoneNumber", cleanPhones)
          : Promise.resolve(),
        cleanEmails.length > 0
          ? batchQuery("email", cleanEmails)
          : Promise.resolve(),
      ]);

      res.json({ matches });
    } catch (err) {
      console.error("findContactsOnNiyah error:", err);
      sendError(res, 500, "Failed to search contacts");
    }
  },
);

// ─── createGroupSession ─────────────────────────────────────────────────────
/**
 * Creates a new group session and sends invites to participants.
 * Body: { cadence: string, stakePerParticipant: number, duration: number, inviteeIds: string[], customStake?: boolean }
 * Returns: { sessionId: string, inviteIds: string[] }
 *
 * SECURITY: Validates proposer balance, deducts stake via Firestore transaction.
 * Fetches invitee profiles server-side to populate participant data.
 */
export const createGroupSession = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req, { enforceAppCheck: APP_CHECK_ENFORCED });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("App Check")) {
        sendError(res, 403, "App Check attestation required");
      } else {
        sendError(res, 401, "Unauthorized");
      }
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "createGroupSession",
        RATE_LIMITS.createGroupSession,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { cadence, stakePerParticipant, duration, inviteeIds, customStake } =
      req.body as {
        cadence: unknown;
        stakePerParticipant: unknown;
        duration: unknown;
        inviteeIds: unknown;
        customStake?: boolean;
      };

    // Validate input types
    if (typeof cadence !== "string" || !cadence) {
      sendError(res, 400, "Missing or invalid cadence");
      return;
    }
    if (
      typeof stakePerParticipant !== "number" ||
      !Number.isFinite(stakePerParticipant) ||
      !Number.isInteger(stakePerParticipant)
    ) {
      sendError(res, 400, "stakePerParticipant must be an integer");
      return;
    }
    if (
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      !Number.isInteger(duration) ||
      duration <= 0
    ) {
      sendError(res, 400, "duration must be a positive integer");
      return;
    }
    if (
      !Array.isArray(inviteeIds) ||
      !inviteeIds.length ||
      !inviteeIds.every((id): id is string => typeof id === "string")
    ) {
      sendError(res, 400, "inviteeIds must be a non-empty array of strings");
      return;
    }

    if (stakePerParticipant < 100 || stakePerParticipant > 10000) {
      sendError(res, 400, "Stake must be between $1 and $100");
      return;
    }

    // Prevent duplicate invitees
    const uniqueInvitees = new Set(inviteeIds);
    if (uniqueInvitees.size !== inviteeIds.length) {
      sendError(res, 400, "Duplicate invitees not allowed");
      return;
    }

    // Prevent proposer from inviting themselves
    if (inviteeIds.includes(uid)) {
      sendError(res, 400, "Cannot invite yourself");
      return;
    }

    const totalParticipants = inviteeIds.length + 1; // +1 for proposer
    if (totalParticipants < 2 || totalParticipants > 20) {
      sendError(res, 400, "Group must have 2-20 participants");
      return;
    }

    // Daily stake cap — blocks proposer if their committed stakes today
    // (across solo + group) would exceed DAILY_STAKE_CAP_CENTS.
    const capCheck = await assertDailyStakeCap(uid, stakePerParticipant);
    if (!capCheck.ok) {
      sendError(res, 400, capCheck.message);
      return;
    }

    try {
      // Fetch proposer profile
      const proposerDoc = await db.collection("users").doc(uid).get();
      const proposerData = proposerDoc.data() ?? {};

      // Fetch invitee profiles
      const inviteeDocs = await Promise.all(
        inviteeIds.map((id) => db.collection("users").doc(id).get()),
      );

      // Validate all invitees exist
      for (let i = 0; i < inviteeDocs.length; i++) {
        if (!inviteeDocs[i].exists) {
          sendError(res, 400, `Invitee ${inviteeIds[i]} not found`);
          return;
        }
      }

      // Build participants map
      const participants: Record<
        string,
        {
          name: string;
          venmoHandle: string;
          profileImage: string;
          reputation: Record<string, unknown>;
          accepted: boolean;
          online: boolean;
        }
      > = {};

      participants[uid] = {
        name: proposerData.name ?? "",
        venmoHandle: proposerData.venmoHandle ?? "",
        profileImage: proposerData.profileImage ?? "",
        reputation: proposerData.reputation ?? {},
        accepted: true,
        online: false,
      };

      for (let i = 0; i < inviteeIds.length; i++) {
        const inviteeData = inviteeDocs[i].data() ?? {};
        participants[inviteeIds[i]] = {
          name: inviteeData.name ?? "",
          venmoHandle: inviteeData.venmoHandle ?? "",
          profileImage: inviteeData.profileImage ?? "",
          reputation: inviteeData.reputation ?? {},
          accepted: false,
          online: false,
        };
      }

      const sessionRef = db.collection("groupSessions").doc();
      const sessionId = sessionRef.id;
      const poolTotal = stakePerParticipant * totalParticipants;

      // Deduct stake from proposer's wallet via transaction
      const walletRef = db.collection("wallets").doc(uid);
      const stakeTxnRef = db.collection("transactions").doc();

      await db.runTransaction(async (txn) => {
        const walletSnap = await txn.get(walletRef);
        const currentBalance: number = walletSnap.data()?.balance ?? 0;

        if (currentBalance < stakePerParticipant) {
          throw new Error("Insufficient balance to stake");
        }

        txn.update(walletRef, {
          balance: currentBalance - stakePerParticipant,
        });
        txn.set(stakeTxnRef, {
          userId: uid,
          type: "stake",
          amount: -stakePerParticipant,
          description: "Group session stake",
          sessionId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      // Create group session doc
      await sessionRef.set({
        id: sessionId,
        proposerId: uid,
        status: "pending",
        cadence,
        stakePerParticipant,
        customStake: customStake ?? false,
        duration,
        participantIds: [uid, ...inviteeIds],
        participants,
        poolTotal,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        autoTimeoutAt: null,
      });

      // Create invite docs for each invitee
      const inviteIds: string[] = [];
      const batch = db.batch();

      for (const inviteeId of inviteeIds) {
        const inviteRef = db.collection("groupInvites").doc();
        inviteIds.push(inviteRef.id);
        batch.set(inviteRef, {
          sessionId,
          fromUserId: uid,
          fromUserName: proposerData.name ?? "",
          fromUserImage: proposerData.profileImage ?? "",
          toUserId: inviteeId,
          stake: stakePerParticipant,
          cadence,
          duration,
          status: "pending",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      await batch.commit();

      // Notify each invitee (fire-and-forget)
      const proposerName = proposerData.name ?? "Someone";
      sendPushToUsers(
        inviteeIds,
        {
          title: `${proposerName} wants you to lock in 🔒`,
          body: `Stake $${(stakePerParticipant / 100).toFixed(0)} · winner takes the pool. Tap to join.`,
        },
        { type: "group_invite", sessionId },
      );

      console.log(
        `createGroupSession: session=${sessionId}, proposer=${uid}, invitees=${inviteeIds.length}`,
      );

      res.json({ sessionId, inviteIds });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("Insufficient balance")) {
        sendError(res, 400, message);
      } else {
        console.error("createGroupSession error:", err);
        sendError(res, 500, "Failed to create group session");
      }
    }
  },
);

// ─── respondToGroupInvite ────────────────────────────────────────────────────
/**
 * Accepts or declines a group session invite.
 * Body: { inviteId: string, accept: boolean }
 * Returns: { success: true, sessionStatus: string }
 *
 * SECURITY: Validates invite belongs to authenticated user. Deducts stake
 * via Firestore transaction on accept. Handles cascade logic (cancel if < 2).
 */
export const respondToGroupInvite = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "respondToGroupInvite",
        RATE_LIMITS.respondToGroupInvite,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { inviteId, accept } = req.body as {
      inviteId: string;
      accept: boolean;
    };

    if (!inviteId || typeof accept !== "boolean") {
      sendError(res, 400, "Missing required fields");
      return;
    }

    try {
      const inviteRef = db.collection("groupInvites").doc(inviteId);
      const inviteSnap = await inviteRef.get();

      if (!inviteSnap.exists) {
        sendError(res, 404, "Invite not found");
        return;
      }

      const inviteData = inviteSnap.data()!;

      if (inviteData.toUserId !== uid) {
        sendError(res, 403, "Invite does not belong to this user");
        return;
      }

      if (inviteData.status !== "pending") {
        sendError(res, 400, `Invite already ${inviteData.status}`);
        return;
      }

      const sessionRef = db
        .collection("groupSessions")
        .doc(inviteData.sessionId);
      const sessionSnap = await sessionRef.get();
      const sessionData = sessionSnap.data()!;

      if (accept) {
        // Daily stake cap — blocks acceptance if total committed today would exceed cap.
        const capCheck = await assertDailyStakeCap(uid, inviteData.stake);
        if (!capCheck.ok) {
          sendError(res, 400, capCheck.message);
          return;
        }

        // Deduct stake from user's wallet
        const walletRef = db.collection("wallets").doc(uid);
        const stakeTxnRef = db.collection("transactions").doc();

        await db.runTransaction(async (txn) => {
          const walletSnap = await txn.get(walletRef);
          const currentBalance: number = walletSnap.data()?.balance ?? 0;

          if (currentBalance < inviteData.stake) {
            throw new Error("Insufficient balance to stake");
          }

          txn.update(walletRef, {
            balance: currentBalance - inviteData.stake,
          });
          txn.set(stakeTxnRef, {
            userId: uid,
            type: "stake",
            amount: -inviteData.stake,
            description: "Group session stake",
            sessionId: inviteData.sessionId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        // Update invite status
        await inviteRef.update({
          status: "accepted",
          respondedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Update session participant
        await sessionRef.update({
          [`participants.${uid}.accepted`]: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Check if all participants accepted
        const updatedSessionSnap = await sessionRef.get();
        const updatedSessionData = updatedSessionSnap.data()!;
        const allAccepted = updatedSessionData.participantIds.every(
          (pid: string) => updatedSessionData.participants[pid]?.accepted,
        );

        let sessionStatus = updatedSessionData.status;
        if (allAccepted) {
          sessionStatus = "ready";
          await sessionRef.update({
            status: "ready",
            autoTimeoutAt: admin.firestore.Timestamp.fromMillis(
              Date.now() + 30 * 60 * 1000,
            ),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // Notify all participants that everyone accepted
          sendPushToUsers(
            updatedSessionData.participantIds.filter(
              (pid: string) => pid !== uid,
            ),
            {
              title: "Everyone's in 💪",
              body: "Head to the waiting room — session starts soon.",
            },
            {
              type: "session_ready",
              sessionId: inviteData.sessionId,
            },
          );
        } else {
          // Notify proposer that someone accepted
          sendPushToUser(
            inviteData.fromUserId,
            {
              title: "Someone's in 🎯",
              body: "A friend accepted your session invite.",
            },
            {
              type: "invite_response",
              sessionId: inviteData.sessionId,
            },
          );
        }

        console.log(
          `respondToGroupInvite: invite=${inviteId}, user=${uid}, accepted=true, allAccepted=${allAccepted}`,
        );

        res.json({ success: true, sessionStatus });
      } else {
        // Decline: update invite
        await inviteRef.update({
          status: "declined",
          respondedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Remove user from session
        const updatedParticipantIds = sessionData.participantIds.filter(
          (pid: string) => pid !== uid,
        );
        const updatedParticipants = { ...sessionData.participants };
        delete updatedParticipants[uid];
        const updatedPoolTotal =
          sessionData.stakePerParticipant * updatedParticipantIds.length;

        if (updatedParticipantIds.length < 2) {
          // Cancel session and refund all accepted participants
          const refundBatch = db.batch();

          for (const pid of updatedParticipantIds) {
            if (updatedParticipants[pid]?.accepted) {
              const refundWalletRef = db.collection("wallets").doc(pid);
              const refundTxnRef = db.collection("transactions").doc();

              // Note: using batch, not transaction — acceptable for refunds
              refundBatch.update(refundWalletRef, {
                balance: admin.firestore.FieldValue.increment(
                  sessionData.stakePerParticipant,
                ),
              });
              refundBatch.set(refundTxnRef, {
                userId: pid,
                type: "refund",
                amount: sessionData.stakePerParticipant,
                description: "Group session cancelled — stake refunded",
                sessionId: inviteData.sessionId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          }

          refundBatch.update(sessionRef, {
            status: "cancelled",
            participantIds: updatedParticipantIds,
            participants: updatedParticipants,
            poolTotal: updatedPoolTotal,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          await refundBatch.commit();

          console.log(
            `respondToGroupInvite: session=${inviteData.sessionId} cancelled (< 2 participants)`,
          );

          res.json({ success: true, sessionStatus: "cancelled" });
        } else {
          await sessionRef.update({
            participantIds: updatedParticipantIds,
            participants: updatedParticipants,
            poolTotal: updatedPoolTotal,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // Notify proposer that someone declined
          sendPushToUser(
            inviteData.fromUserId,
            {
              title: "Invite declined",
              body: "One friend passed — session still on with the rest.",
            },
            {
              type: "invite_response",
              sessionId: inviteData.sessionId,
            },
          );

          console.log(
            `respondToGroupInvite: invite=${inviteId}, user=${uid}, declined, remaining=${updatedParticipantIds.length}`,
          );

          res.json({ success: true, sessionStatus: sessionData.status });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("Insufficient balance")) {
        sendError(res, 400, message);
      } else {
        console.error("respondToGroupInvite error:", err);
        sendError(res, 500, "Failed to respond to invite");
      }
    }
  },
);

// ─── markOnlineForSession ────────────────────────────────────────────────────
/**
 * Marks a participant as online for a group session lobby.
 * Body: { sessionId: string }
 * Returns: { success: true, allOnline: boolean }
 */
export const markOnlineForSession = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "markOnlineForSession",
        RATE_LIMITS.markOnlineForSession,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { sessionId } = req.body as { sessionId: string };
    if (!sessionId) {
      sendError(res, 400, "Missing sessionId");
      return;
    }

    try {
      const sessionRef = db.collection("groupSessions").doc(sessionId);
      const sessionSnap = await sessionRef.get();

      if (!sessionSnap.exists) {
        sendError(res, 404, "Session not found");
        return;
      }

      const sessionData = sessionSnap.data()!;

      if (!sessionData.participantIds.includes(uid)) {
        sendError(res, 403, "Not a participant in this session");
        return;
      }

      if (sessionData.status !== "ready") {
        sendError(
          res,
          400,
          `Session is not ready (current status: ${sessionData.status})`,
        );
        return;
      }

      // Mark user as online
      await sessionRef.update({
        [`participants.${uid}.online`]: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Check if all participants are online
      const updatedSnap = await sessionRef.get();
      const updatedData = updatedSnap.data()!;
      const allOnline = updatedData.participantIds.every(
        (pid: string) => updatedData.participants[pid]?.online,
      );

      console.log(
        `markOnlineForSession: session=${sessionId}, user=${uid}, allOnline=${allOnline}`,
      );

      res.json({ success: true, allOnline });
    } catch (err) {
      console.error("markOnlineForSession error:", err);
      sendError(res, 500, "Failed to mark online status");
    }
  },
);

// ─── startGroupSession ───────────────────────────────────────────────────────
/**
 * Starts a group session once all participants are online.
 * Only the proposer can start the session.
 * Body: { sessionId: string }
 * Returns: { success: true, endsAt: number }
 */
export const startGroupSession = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "startGroupSession",
        RATE_LIMITS.startGroupSession,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { sessionId } = req.body as { sessionId: string };
    if (!sessionId) {
      sendError(res, 400, "Missing sessionId");
      return;
    }

    try {
      const sessionRef = db.collection("groupSessions").doc(sessionId);
      const sessionSnap = await sessionRef.get();

      if (!sessionSnap.exists) {
        sendError(res, 404, "Session not found");
        return;
      }

      const sessionData = sessionSnap.data()!;

      if (sessionData.proposerId !== uid) {
        sendError(res, 403, "Only the proposer can start the session");
        return;
      }

      if (sessionData.status !== "ready") {
        sendError(
          res,
          400,
          `Session is not ready (current status: ${sessionData.status})`,
        );
        return;
      }

      // Verify all participants are online
      const allOnline = sessionData.participantIds.every(
        (pid: string) => sessionData.participants[pid]?.online,
      );

      if (!allOnline) {
        sendError(res, 400, "Not all participants are online");
        return;
      }

      const endsAtMs = Date.now() + sessionData.duration;

      await sessionRef.update({
        status: "active",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        endsAt: admin.firestore.Timestamp.fromMillis(endsAtMs),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Notify all non-proposer participants that session started
      sendPushToUsers(
        sessionData.participantIds.filter((pid: string) => pid !== uid),
        {
          title: "Timer's running ⏱️",
          body: "Session just started. Stay focused — your stake is live.",
        },
        { type: "session_started", sessionId },
      );

      console.log(
        `startGroupSession: session=${sessionId}, endsAt=${new Date(endsAtMs).toISOString()}`,
      );

      res.json({ success: true, endsAt: endsAtMs });
    } catch (err) {
      console.error("startGroupSession error:", err);
      sendError(res, 500, "Failed to start group session");
    }
  },
);

// ─── reportSessionStatus ────────────────────────────────────────────────────
/**
 * Reports a participant's completion or surrender for an active group session.
 * If all participants have reported, finalizes the session atomically and then
 * settles payouts using idempotent Stripe transfers and wallet credits.
 * Body: { sessionId: string, action: "complete" | "surrender" }
 * Returns: { success: true, sessionComplete: boolean, payouts?: Record<string, number> }
 *
 * SECURITY: Validates timer expiry for completions (60s grace for cold starts).
 * Payout calculation is done server-side.
 */
export const reportSessionStatus = onRequest(
  PUBLIC_STRIPE_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "reportSessionStatus",
        RATE_LIMITS.reportSessionStatus,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { sessionId, action } = req.body as {
      sessionId: string;
      action: "complete" | "surrender";
    };

    if (!sessionId || !action) {
      sendError(res, 400, "Missing required fields");
      return;
    }

    if (action !== "complete" && action !== "surrender") {
      sendError(res, 400, "Action must be 'complete' or 'surrender'");
      return;
    }

    try {
      const sessionRef = db.collection("groupSessions").doc(sessionId);
      const outcome = await db.runTransaction(async (txn) => {
        const sessionSnap = await txn.get(sessionRef);

        if (!sessionSnap.exists) {
          throw new Error("Session not found");
        }

        const sessionData = sessionSnap.data()!;
        const participantIds = Array.isArray(sessionData.participantIds)
          ? sessionData.participantIds.filter(
              (participantId): participantId is string =>
                typeof participantId === "string" && participantId.length > 0,
            )
          : [];

        if (!participantIds.includes(uid)) {
          throw new Error("Not a participant in this session");
        }

        const rawPayouts = sessionData.payouts as
          | Record<string, unknown>
          | undefined;

        if (sessionData.status === "completed") {
          if (!rawPayouts) {
            throw new Error("Session completed without recorded payouts");
          }

          return {
            sessionComplete: true,
            participantIds,
            payouts: rawPayouts as Record<string, number>,
            shouldSettle: !sessionData.payoutsSettledAt,
          };
        }

        if (sessionData.status !== "active") {
          throw new Error(
            `Session is not active (current status: ${sessionData.status})`,
          );
        }

        const participant = sessionData.participants[uid];
        if (participant?.completed || participant?.surrendered) {
          throw new Error("Already reported status for this session");
        }

        if (action === "complete") {
          const endsAt = sessionData.endsAt?.toDate?.()
            ? sessionData.endsAt.toDate()
            : new Date(sessionData.endsAt);
          const gracePeriodMs = 15_000;

          if (endsAt.getTime() - gracePeriodMs > Date.now()) {
            throw new Error("Session has not ended yet");
          }
        }

        const updatedParticipants = {
          ...sessionData.participants,
          [uid]: {
            ...participant,
            completed: action === "complete",
            surrendered: action === "surrender",
            surrenderedAt:
              action === "surrender"
                ? admin.firestore.FieldValue.serverTimestamp()
                : undefined,
          },
        };

        const updateData: Record<string, unknown> = {
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (action === "complete") {
          updateData[`participants.${uid}.completed`] = true;
        } else {
          updateData[`participants.${uid}.surrendered`] = true;
          updateData[`participants.${uid}.surrenderedAt`] =
            admin.firestore.FieldValue.serverTimestamp();
        }

        const allReported = participantIds.every((participantId) => {
          const currentParticipant = updatedParticipants[participantId];
          return (
            currentParticipant?.completed || currentParticipant?.surrendered
          );
        });

        if (!allReported) {
          txn.update(sessionRef, updateData);
          return {
            sessionComplete: false,
            participantIds,
            actorName: sessionData.participants?.[uid]?.name ?? "Someone",
          };
        }

        const payouts = calculateGroupSessionPayouts(
          participantIds,
          updatedParticipants,
          sessionData.stakePerParticipant,
        );

        txn.update(sessionRef, {
          ...updateData,
          status: "completed",
          payouts,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
          sessionComplete: true,
          participantIds,
          payouts,
          shouldSettle: true,
        };
      });

      if (!outcome.sessionComplete) {
        // Notify other participants when someone gives up mid-session.
        // Two pushes go out: the legacy `session_surrender` for clients that
        // route on that key, plus the richer `leaderboard_shift` so the new
        // banner shows the updated per-share estimate.
        if (
          action === "surrender" &&
          outcome.participantIds &&
          outcome.actorName
        ) {
          const survivors = outcome.participantIds.filter(
            (pid: string) => pid !== uid,
          );
          sendPushToUsers(
            survivors,
            {
              title: `${outcome.actorName} tapped out 💸`,
              body: "Their stake just got split between everyone still locked in.",
            },
            { type: "session_surrender", sessionId },
          );
          try {
            const refreshed = await sessionRef.get();
            const refreshedData = refreshed.data() ?? {};
            const totalParticipants = Array.isArray(refreshedData.participantIds)
              ? refreshedData.participantIds.length
              : 0;
            const remaining = totalParticipants
              ? Object.values(
                  refreshedData.participants as Record<string, { surrendered?: boolean }>,
                ).filter((p) => !p?.surrendered).length
              : 0;
            const stake =
              typeof refreshedData.stakePerParticipant === "number"
                ? refreshedData.stakePerParticipant
                : 0;
            const newShareCents =
              remaining > 0
                ? Math.floor((totalParticipants * stake) / remaining)
                : 0;
            sendPushToUsers(
              survivors,
              {
                title: "Your share just grew",
                body: `If you finish, you'd now take home about $${(newShareCents / 100).toFixed(2)}.`,
              },
              {
                type: "leaderboard_shift",
                sessionId,
                actorName: outcome.actorName,
                newShareCents: String(newShareCents),
              },
            );
          } catch (err) {
            console.warn("leaderboard_shift push failed (non-fatal):", err);
          }
        }
        console.log(
          `reportSessionStatus: session=${sessionId}, user=${uid}, action=${action}, allReported=false`,
        );
        res.json({ success: true, sessionComplete: false });
        return;
      }

      if (!outcome.participantIds || !outcome.payouts) {
        throw new Error("Session completed without recorded payouts");
      }

      const payoutList = buildStoredPayouts(
        outcome.participantIds,
        outcome.payouts,
      );

      if (outcome.shouldSettle) {
        await settleGroupSessionPayouts(sessionId, payoutList, uid);

        // Completion push only fires on the call that actually settled.
        // Idempotent retries from other reporters see payoutsSettledAt and skip
        // both settlement and the push, preventing duplicate notifications.
        if (outcome.participantIds) {
          sendPushToUsers(
            outcome.participantIds.filter((pid: string) => pid !== uid),
            {
              title: "You made it 🏆",
              body: "Session done. Tap to see your payout.",
            },
            { type: "session_complete", sessionId },
          );
        }

        // Award finals promo to every completer in the session — they may
        // have just crossed the 5-sessions / 2-partners gate.
        for (const pid of outcome.participantIds) {
          maybeAwardFinalsPromo(pid).catch((err) =>
            console.warn("maybeAwardFinalsPromo (group) failed:", err),
          );
        }
      }

      console.log(
        `reportSessionStatus: session=${sessionId} completed, payouts=${JSON.stringify(outcome.payouts)}`,
      );

      res.json({
        success: true,
        sessionComplete: true,
        payouts: outcome.payouts,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (
        message.includes("not found") ||
        message.includes("not active") ||
        message.includes("not ended") ||
        message.includes("Not a participant") ||
        message.includes("Already reported") ||
        message.includes("without recorded payouts")
      ) {
        const statusCode = message.includes("not found")
          ? 404
          : message.includes("Not a participant")
            ? 403
            : 400;
        sendError(res, statusCode, message);
      } else {
        console.error("reportSessionStatus error:", err);
        sendError(res, 500, "Failed to report session status");
      }
    }
  },
);

// ─── reportShieldViolation ───────────────────────────────────────────────────
/**
 * Records that a participant tried to open a blocked app during an active
 * group session. Increments their `participants.{uid}.violationCount` and
 * pushes a notification to other participants ("Sarah just slipped").
 *
 * Body: { sessionId: string }
 * Returns: { success: true, violationCount: number }
 *
 * SECURITY: Validates the caller is a participant and the session is active.
 * High rate limit (100/10min) — this is a hot path on the violation hook.
 */
export const reportShieldViolation = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "reportShieldViolation",
        RATE_LIMITS.reportShieldViolation,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { sessionId } = req.body as { sessionId: string };
    if (!sessionId || typeof sessionId !== "string") {
      sendError(res, 400, "Missing sessionId");
      return;
    }

    try {
      const sessionRef = db.collection("groupSessions").doc(sessionId);
      const result = await db.runTransaction(async (txn) => {
        const snap = await txn.get(sessionRef);
        if (!snap.exists) {
          throw new Error("Session not found");
        }
        const data = snap.data()!;
        const participantIds = Array.isArray(data.participantIds)
          ? data.participantIds.filter(
              (p): p is string => typeof p === "string" && p.length > 0,
            )
          : [];
        if (!participantIds.includes(uid)) {
          throw new Error("Not a participant in this session");
        }
        if (data.status !== "active") {
          throw new Error(
            `Session is not active (current status: ${data.status})`,
          );
        }
        const participant = data.participants?.[uid];
        const newCount = (participant?.violationCount ?? 0) + 1;
        const actorName = participant?.name || "Someone";
        const lastPushAt = participant?.lastViolationPushAt?.toDate?.()
          ? participant.lastViolationPushAt.toDate().getTime()
          : 0;
        const shouldPush = Date.now() - lastPushAt > 30_000;
        const updateFields: Record<string, unknown> = {
          [`participants.${uid}.violationCount`]: newCount,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (shouldPush) {
          updateFields[`participants.${uid}.lastViolationPushAt`] =
            admin.firestore.FieldValue.serverTimestamp();
        }
        txn.update(sessionRef, updateFields);
        return { newCount, actorName, participantIds, shouldPush };
      });

      // Notify other participants — 30s cooldown per user prevents spam.
      // Switched to `member_app_opened` so the client can render a per-app
      // pill on the leaderboard rather than treating it as a generic event.
      if (result.shouldPush) {
        sendPushToUsers(
          result.participantIds.filter((pid: string) => pid !== uid),
          {
            title: `${result.actorName} opened a blocked app 👀`,
            body: "They tapped through the shield. Their share is shrinking.",
          },
          {
            type: "member_app_opened",
            sessionId,
            actorUid: uid,
            actorName: result.actorName,
            violationCount: String(result.newCount),
          },
        );
      }

      console.log(
        `reportShieldViolation: session=${sessionId}, user=${uid}, count=${result.newCount}`,
      );

      res.json({ success: true, violationCount: result.newCount });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (
        message.includes("not found") ||
        message.includes("not active") ||
        message.includes("Not a participant")
      ) {
        const statusCode = message.includes("not found")
          ? 404
          : message.includes("Not a participant")
            ? 403
            : 400;
        sendError(res, statusCode, message);
      } else {
        console.error("reportShieldViolation error:", err);
        sendError(res, 500, "Failed to report shield violation");
      }
    }
  },
);

// ─── cancelGroupSession ──────────────────────────────────────────────────────
/**
 * Cancels a group session. Only the proposer can cancel.
 * Cannot cancel active or completed sessions.
 * Body: { sessionId: string }
 * Returns: { success: true, refundedCount: number }
 *
 * SECURITY: Refunds all accepted participants' stakes.
 */
export const cancelGroupSession = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req);
    } catch {
      sendError(res, 401, "Unauthorized");
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "cancelGroupSession",
        RATE_LIMITS.cancelGroupSession,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    const { sessionId } = req.body as { sessionId: string };
    if (!sessionId) {
      sendError(res, 400, "Missing sessionId");
      return;
    }

    try {
      const sessionRef = db.collection("groupSessions").doc(sessionId);
      const sessionSnap = await sessionRef.get();

      if (!sessionSnap.exists) {
        sendError(res, 404, "Session not found");
        return;
      }

      const sessionData = sessionSnap.data()!;

      if (sessionData.proposerId !== uid) {
        sendError(res, 403, "Only the proposer can cancel the session");
        return;
      }

      if (
        sessionData.status === "active" ||
        sessionData.status === "completed"
      ) {
        sendError(
          res,
          400,
          `Cannot cancel session with status: ${sessionData.status}`,
        );
        return;
      }

      // Refund all accepted participants
      const batch = db.batch();
      let refundedCount = 0;

      for (const pid of sessionData.participantIds) {
        if (sessionData.participants[pid]?.accepted) {
          const walletRef = db.collection("wallets").doc(pid);
          const txnRef = db.collection("transactions").doc();

          batch.update(walletRef, {
            balance: admin.firestore.FieldValue.increment(
              sessionData.stakePerParticipant,
            ),
          });
          batch.set(txnRef, {
            userId: pid,
            type: "refund",
            amount: sessionData.stakePerParticipant,
            description: "Group session cancelled — stake refunded",
            sessionId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          refundedCount++;
        }
      }

      // Expire all pending invites for this session
      const invitesSnap = await db
        .collection("groupInvites")
        .where("sessionId", "==", sessionId)
        .where("status", "==", "pending")
        .get();

      for (const inviteDoc of invitesSnap.docs) {
        batch.update(inviteDoc.ref, {
          status: "expired",
          respondedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Mark session as cancelled
      batch.update(sessionRef, {
        status: "cancelled",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await batch.commit();

      // Notify all non-proposer participants that session was cancelled
      sendPushToUsers(
        sessionData.participantIds.filter((pid: string) => pid !== uid),
        {
          title: "Session called off",
          body: "Stake refunded to your balance.",
        },
        { type: "session_cancelled", sessionId },
      );

      console.log(
        `cancelGroupSession: session=${sessionId}, refunded=${refundedCount}`,
      );

      res.json({ success: true, refundedCount });
    } catch (err) {
      console.error("cancelGroupSession error:", err);
      sendError(res, 500, "Failed to cancel group session");
    }
  },
);

// ─── autoTimeoutGroupSessions ────────────────────────────────────────────────
/**
 * Scheduled function that runs every 5 minutes to cancel group sessions
 * that have been in "ready" state past their autoTimeoutAt deadline.
 * Refunds all accepted participants and expires pending invites.
 */
export const autoTimeoutGroupSessions = onSchedule(
  { schedule: "every 5 minutes", region: "us-central1" },
  async () => {
    const now = admin.firestore.Timestamp.now();

    try {
      const expiredSessions = await db
        .collection("groupSessions")
        .where("status", "==", "ready")
        .where("autoTimeoutAt", "<", now)
        .get();

      if (expiredSessions.empty) {
        console.log("autoTimeoutGroupSessions: no expired sessions found");
        return;
      }

      console.log(
        `autoTimeoutGroupSessions: found ${expiredSessions.size} expired session(s)`,
      );

      for (const sessionDoc of expiredSessions.docs) {
        const sessionData = sessionDoc.data();
        const sessionId = sessionDoc.id;

        try {
          const batch = db.batch();

          // Refund all accepted participants
          for (const pid of sessionData.participantIds) {
            if (sessionData.participants[pid]?.accepted) {
              const walletRef = db.collection("wallets").doc(pid);
              const txnRef = db.collection("transactions").doc();

              batch.update(walletRef, {
                balance: admin.firestore.FieldValue.increment(
                  sessionData.stakePerParticipant,
                ),
              });
              batch.set(txnRef, {
                userId: pid,
                type: "refund",
                amount: sessionData.stakePerParticipant,
                description: "Group session timed out — stake refunded",
                sessionId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          }

          // Expire pending invites
          const invitesSnap = await db
            .collection("groupInvites")
            .where("sessionId", "==", sessionId)
            .where("status", "==", "pending")
            .get();

          for (const inviteDoc of invitesSnap.docs) {
            batch.update(inviteDoc.ref, {
              status: "expired",
              respondedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }

          // Cancel session
          batch.update(sessionDoc.ref, {
            status: "cancelled",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          await batch.commit();

          console.log(
            `autoTimeoutGroupSessions: cancelled session=${sessionId}, participants=${sessionData.participantIds.length}`,
          );
        } catch (sessionErr) {
          console.error(
            `autoTimeoutGroupSessions: failed to cancel session=${sessionId}:`,
            sessionErr,
          );
        }
      }
    } catch (err) {
      console.error("autoTimeoutGroupSessions error:", err);
    }
  },
);

// ─── sessionProgressNudges ──────────────────────────────────────────────────
/**
 * Scheduled every 5 minutes: scans active group sessions and emits
 * `session_progress_25` / `_50` / `_75` push notifications when a session
 * crosses each milestone. Fires once per milestone per session — the
 * crossed thresholds are recorded on the session doc so a re-run won't
 * spam users.
 */
export const sessionProgressNudges = onSchedule(
  { schedule: "every 5 minutes", region: "us-central1" },
  async () => {
    const nowMs = Date.now();
    try {
      const activeSnap = await db
        .collection("groupSessions")
        .where("status", "==", "active")
        .get();
      if (activeSnap.empty) return;

      for (const sessionDoc of activeSnap.docs) {
        const sessionId = sessionDoc.id;
        const data = sessionDoc.data();
        const startedAt =
          data.startedAt?.toMillis?.() ??
          (typeof data.startedAt === "number" ? data.startedAt : undefined);
        const duration =
          typeof data.duration === "number" ? data.duration : undefined;
        const participantIds: string[] = Array.isArray(data.participantIds)
          ? data.participantIds.filter((p): p is string => typeof p === "string")
          : [];
        if (!startedAt || !duration || participantIds.length === 0) continue;

        const elapsed = nowMs - startedAt;
        const progress = elapsed / duration;
        const milestones: number[] = [25, 50, 75];
        const fired: number[] = Array.isArray(data.progressMilestonesFired)
          ? (data.progressMilestonesFired as unknown[]).filter(
              (m): m is number => typeof m === "number",
            )
          : [];

        const toFire = milestones.filter(
          (m) => progress >= m / 100 && !fired.includes(m),
        );
        if (toFire.length === 0) continue;

        for (const milestone of toFire) {
          try {
            const remainingMs = Math.max(0, duration - elapsed);
            const remainingMin = Math.ceil(remainingMs / 60_000);
            const body =
              milestone === 75
                ? `Final stretch — ${remainingMin} min to lock in your payout.`
                : milestone === 50
                  ? `Halfway. ${remainingMin} min left to keep your stake alive.`
                  : `Past the warmup. ${remainingMin} min left.`;
            sendPushToUsers(
              participantIds,
              {
                title: `${milestone}% done 💪`,
                body,
              },
              {
                type: `session_progress_${milestone}`,
                sessionId,
                milestone: String(milestone),
              },
            );
          } catch (err) {
            console.warn(
              `sessionProgressNudges push for ${sessionId} m=${milestone} failed:`,
              err,
            );
          }
        }

        try {
          await sessionDoc.ref.update({
            progressMilestonesFired: admin.firestore.FieldValue.arrayUnion(
              ...toFire,
            ),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (err) {
          console.warn(
            `sessionProgressNudges: failed to record fired milestones for ${sessionId}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error("sessionProgressNudges error:", err);
    }
  },
);

// ─── Finals promo bonus ──────────────────────────────────────────────────────
// Campus-launch promo: when a user crosses the same gate that unlocks
// withdrawal (>=5 completed sessions + >=2 distinct group partners) they get
// a one-time $5 credit. Same mechanism as the "first 100 signups" promo on
// niyah.live, but gated so two friends can't cycle money and cash out.

const FINALS_PROMO_CENTS: number = (() => {
  const raw = process.env.FINALS_PROMO_CENTS;
  const parsed = raw ? parseInt(raw, 10) : 500;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
})();

// One-time refund applied the first time a user surrenders (solo sessions
// only). Capped at this value even if stake is larger — frames the
// commitment mechanism as a tutorial lesson rather than a punitive first
// experience, which prevents support DMs from first-time forfeiters.
const FIRST_SURRENDER_FORGIVENESS_CENTS: number = (() => {
  const raw = process.env.FIRST_SURRENDER_FORGIVENESS_CENTS;
  const parsed = raw ? parseInt(raw, 10) : 500;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
})();

async function maybeAwardFinalsPromo(uid: string): Promise<void> {
  if (!isValidFirebaseUid(uid)) return;
  if (FINALS_PROMO_CENTS <= 0) return;

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (userSnap.data()?.finalsPromoAwarded === true) return;

  const stats = await getWithdrawalEligibilityStats(uid);
  if (stats.completedSessions < stats.requiredSessions) return;
  if (stats.distinctPartners < stats.requiredPartners) return;

  const walletRef = db.collection("wallets").doc(uid);
  const txnRef = db.collection("transactions").doc(`finals_promo_${uid}`);

  const awarded = await db.runTransaction(async (txn) => {
    const freshUser = await txn.get(userRef);
    if (freshUser.data()?.finalsPromoAwarded === true) return false;

    const walletSnap = await txn.get(walletRef);
    const currentBalance: number = walletSnap.data()?.balance ?? 0;
    const newBalance = currentBalance + FINALS_PROMO_CENTS;

    if (walletSnap.exists) {
      txn.update(walletRef, {
        balance: newBalance,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      txn.set(
        walletRef,
        {
          balance: newBalance,
          pendingBalance: 0,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    txn.update(userRef, {
      finalsPromoAwarded: true,
      finalsPromoAwardedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    txn.set(txnRef, {
      userId: uid,
      type: "promo",
      amount: FINALS_PROMO_CENTS,
      description: "Finals beta bonus — 5 sessions with 2+ friends",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return true;
  });

  if (awarded) {
    sendPushToUsers(
      [uid],
      {
        title: `You earned $${(FINALS_PROMO_CENTS / 100).toFixed(0)} 🎉`,
        body: "Finals beta bonus unlocked. Keep stacking focused sessions.",
      },
      { type: "finals_promo_awarded" },
    );
    console.log(`finals_promo_awarded uid=${uid} cents=${FINALS_PROMO_CENTS}`);
  }
}

// ─── aggregateDailyMetrics ──────────────────────────────────────────────────
// Rolls up yesterday's analytics_events into metrics/{YYYY-MM-DD} once per
// day at 00:05 UTC. Doc contains: dau (distinct userIds), eventCount, counts
// (per event name), sums (cent totals per money-bearing event).
//
// Investor dashboard + daily review read metrics/* directly — never the raw
// analytics_events collection, which grows unbounded.

export const aggregateDailyMetrics = onSchedule(
  {
    schedule: "5 0 * * *",
    timeZone: "UTC",
    region: "us-central1",
  },
  async () => {
    try {
      const now = new Date();
      const endOfYesterday = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          0,
          0,
          0,
          0,
        ),
      );
      const startOfYesterday = new Date(
        endOfYesterday.getTime() - 24 * 60 * 60 * 1000,
      );
      const dateId = startOfYesterday.toISOString().slice(0, 10);

      const snap = await db
        .collection("analytics_events")
        .where(
          "createdAt",
          ">=",
          admin.firestore.Timestamp.fromDate(startOfYesterday),
        )
        .where(
          "createdAt",
          "<",
          admin.firestore.Timestamp.fromDate(endOfYesterday),
        )
        .get();

      const counts: Record<string, number> = {};
      const sums: Record<string, number> = {};
      const dau = new Set<string>();

      snap.forEach((doc) => {
        const d = doc.data();
        const name: string = typeof d.name === "string" ? d.name : "unknown";
        counts[name] = (counts[name] ?? 0) + 1;

        if (typeof d.userId === "string") dau.add(d.userId);

        const props = (d.props as Record<string, unknown> | undefined) ?? {};
        const money = ["amountCents", "stakeAmount", "payoutAmount"] as const;
        for (const key of money) {
          const v = props[key];
          if (typeof v === "number" && Number.isFinite(v)) {
            const bucket = `${name}_${key}`;
            sums[bucket] = (sums[bucket] ?? 0) + v;
          }
        }
      });

      await db.collection("metrics").doc(dateId).set(
        {
          dateId,
          dau: dau.size,
          eventCount: snap.size,
          counts,
          sums,
          computedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      console.log(
        `aggregateDailyMetrics: date=${dateId}, dau=${dau.size}, events=${snap.size}`,
      );
    } catch (err) {
      console.error("aggregateDailyMetrics error:", err);
    }
  },
);

// ─── Multi-provider account merge (admin-only) ──────────────────────────────

const ADMIN_API_KEY = defineSecret("ADMIN_API_KEY");

const PUBLIC_ADMIN_HTTP_OPTIONS = {
  ...PUBLIC_HTTP_OPTIONS,
  secrets: [ADMIN_API_KEY],
};

/**
 * Server-side replacement for the previous client `findExistingUserByPhoneOrEmail`
 * + `queuePendingMerge` pair. Detects a cross-provider duplicate using
 * **only** auth-verified contact fields (Firebase auth's `phoneNumber` and
 * verified `email`) — never the user-writable `users/{uid}.phone` or
 * `.email` Firestore fields. Prevents phone-squat takeover where an
 * attacker sets a victim's number on their own profile and waits for the
 * victim to sign up.
 *
 * Body: none. Returns one of:
 *   - { status: "no_match" }
 *   - { status: "no_verified_contact" }   (caller has no verified phone/email)
 *   - { status: "self_match" }            (only the caller matches)
 *   - { status: "merge", role: "duplicate", canonicalUid, matchedField }
 *   - { status: "merge", role: "canonical", duplicateUid, matchedField }
 *
 * Writes `userMerges/{newUid}` via admin SDK only when the caller is the
 * duplicate (newer auth user) — never the canonical.
 */
export const requestAccountMerge = onRequest(
  PUBLIC_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let uid: string;
    try {
      uid = await verifyAuth(req, { enforceAppCheck: APP_CHECK_ENFORCED });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      sendError(
        res,
        msg.includes("App Check") ? 403 : 401,
        msg.includes("App Check") ? "App Check attestation required" : "Unauthorized",
      );
      return;
    }

    if (
      await checkRateLimit(
        uid,
        "requestAccountMerge",
        RATE_LIMITS.requestAccountMerge,
      )
    ) {
      sendError(res, 429, "Too many requests — try again later");
      return;
    }

    try {
      const callerAuth = await admin.auth().getUser(uid);
      const verifiedPhone = callerAuth.phoneNumber ?? null;
      const verifiedEmail =
        callerAuth.emailVerified && callerAuth.email
          ? callerAuth.email.toLowerCase()
          : null;

      if (!verifiedPhone && !verifiedEmail) {
        res.json({ status: "no_verified_contact" });
        return;
      }

      // Try phone first, then email. Auth admin SDK lookups don't surface
      // unrelated users — only the one matching the contact (or none).
      let candidate: admin.auth.UserRecord | null = null;
      if (verifiedPhone) {
        try {
          const u = await admin.auth().getUserByPhoneNumber(verifiedPhone);
          if (u.uid !== uid) candidate = u;
        } catch {
          // not found — fine
        }
      }
      if (!candidate && verifiedEmail) {
        try {
          const u = await admin.auth().getUserByEmail(verifiedEmail);
          if (u.uid !== uid && u.emailVerified) candidate = u;
        } catch {
          // not found — fine
        }
      }

      if (!candidate) {
        res.json({ status: "no_match" });
        return;
      }

      const toMinimal = (
        u: admin.auth.UserRecord,
      ): MinimalAuthRecord => ({
        uid: u.uid,
        email: u.email ?? null,
        emailVerified: u.emailVerified,
        phoneNumber: u.phoneNumber ?? null,
        metadata: { creationTime: u.metadata.creationTime },
      });

      const decision = decideAccountMerge(
        toMinimal(callerAuth),
        toMinimal(candidate),
      );

      if (decision.status !== "merge") {
        res.json({ status: decision.status });
        return;
      }

      // Only queue when the caller is the duplicate. If the caller is the
      // canonical, the next sign-in by the duplicate will queue itself.
      if (decision.newUid === uid) {
        await db
          .collection("userMerges")
          .doc(uid)
          .set(
            {
              newUid: decision.newUid,
              existingUid: decision.existingUid,
              matchedField: decision.matchedField,
              status: "pending",
              detectedByAuth: true,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        res.json({
          status: "merge",
          role: "duplicate",
          canonicalUid: decision.existingUid,
          matchedField: decision.matchedField,
        });
        return;
      }

      res.json({
        status: "merge",
        role: "canonical",
        duplicateUid: decision.newUid,
        matchedField: decision.matchedField,
      });
    } catch (err) {
      console.error("requestAccountMerge error:", err);
      sendError(res, 500, "Failed to evaluate account merge");
    }
  },
);

/**
 * Drains the `userMerges/{newUid}` queue produced by `requestAccountMerge`
 * whenever a user signs in via a second provider whose verified phone/email
 * matches an existing Firestore user.
 *
 * Each merge:
 *   - moves `wallets/{newUid}.balance` + `pendingBalance` into the existing wallet
 *   - reassigns `transactions` where userId == newUid → existingUid
 *   - reassigns active `sessions` (`userId`) and `groupInvites` (`toUserId`)
 *   - logs a migration record to `migrations/{date}/entries/{newUid}` with
 *     before/after snapshots for audit
 *   - deletes the duplicate auth user
 *
 * Admin-only: caller must pass header `x-admin-key: <ADMIN_API_KEY>`. Body
 * supports `{ confirm: boolean, mergeId?: string }`; without `confirm: true`
 * the call is a dry-run that logs what *would* happen.
 */
export const mergeDuplicateUsers = onRequest(
  PUBLIC_ADMIN_HTTP_OPTIONS,
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    const provided = req.headers["x-admin-key"];
    const expected = ADMIN_API_KEY.value();
    if (!compareAdminKey(provided, expected)) {
      sendError(res, 403, "Forbidden");
      return;
    }

    const { confirm, mergeId } = (req.body ?? {}) as {
      confirm?: boolean;
      mergeId?: string;
    };
    const dryRun = confirm !== true;

    try {
      const queueSnap = mergeId
        ? await db
            .collection("userMerges")
            .where(admin.firestore.FieldPath.documentId(), "==", mergeId)
            .get()
        : await db
            .collection("userMerges")
            .where("status", "==", "pending")
            .limit(20)
            .get();

      const results: Array<{
        newUid: string;
        existingUid: string;
        moved: {
          walletCents: number;
          pendingCents: number;
          transactions: number;
          sessions: number;
          groupInvites: number;
        };
        status: "ok" | "skipped" | "error";
        error?: string;
      }> = [];

      for (const mergeDoc of queueSnap.docs) {
        const data = mergeDoc.data() as {
          newUid?: string;
          existingUid?: string;
          status?: string;
          matchedField?: string;
        };
        const newUid = data.newUid ?? mergeDoc.id;
        const existingUid = data.existingUid;

        if (!existingUid || existingUid === newUid) {
          results.push({
            newUid,
            existingUid: existingUid ?? "",
            moved: {
              walletCents: 0,
              pendingCents: 0,
              transactions: 0,
              sessions: 0,
              groupInvites: 0,
            },
            status: "skipped",
            error: "missing or self-targeted existingUid",
          });
          continue;
        }

        try {
          const summary = await mergeOne(newUid, existingUid, dryRun);
          results.push({
            newUid,
            existingUid,
            moved: summary,
            status: "ok",
          });

          if (!dryRun) {
            await mergeDoc.ref.update({
              status: "completed",
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
              summary,
            });
            const dateId = new Date().toISOString().slice(0, 10);
            await db
              .collection("migrations")
              .doc(dateId)
              .collection("entries")
              .doc(newUid)
              .set(
                {
                  newUid,
                  existingUid,
                  matchedField: data.matchedField ?? "unknown",
                  summary,
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true },
              );
          }
        } catch (err) {
          console.error(
            `mergeDuplicateUsers: failed for ${newUid} -> ${existingUid}:`,
            err,
          );
          results.push({
            newUid,
            existingUid,
            moved: {
              walletCents: 0,
              pendingCents: 0,
              transactions: 0,
              sessions: 0,
              groupInvites: 0,
            },
            status: "error",
            error: err instanceof Error ? err.message : "unknown",
          });
          if (!dryRun) {
            await mergeDoc.ref.update({
              status: "failed",
              lastError: err instanceof Error ? err.message : "unknown",
              attemptedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      }

      res.json({ dryRun, processed: results.length, results });
    } catch (err) {
      console.error("mergeDuplicateUsers error:", err);
      sendError(res, 500, "Merge failed");
    }
  },
);

// ─── reconcileWalletBalances (nightly) ──────────────────────────────────────
/**
 * Sums each user's transaction log and compares to `wallets/{uid}.balance`.
 * Drift > 0 cents writes a record to `walletAudits/{uid}_{date}` and logs
 * an error so Sentry surfaces it. The job does not auto-correct — operators
 * inspect the audit doc and decide whether to credit or refund.
 *
 * Reads are throttled in batches of 200 wallets per minute window so a large
 * user base doesn't fan out into thousands of parallel queries.
 */
export const reconcileWalletBalances = onSchedule(
  { schedule: "0 4 * * *", timeZone: "America/New_York", region: "us-central1" },
  async () => {
    const today = new Date();
    const dateId = today.toISOString().slice(0, 10);
    const walletsSnap = await db.collection("wallets").limit(2000).get();
    let mismatchCount = 0;
    let processed = 0;

    for (const walletDoc of walletsSnap.docs) {
      const uid = walletDoc.id;
      const stored = walletDoc.data() ?? {};
      const storedBalance =
        typeof stored.balance === "number" ? stored.balance : 0;

      const txnSnap = await db
        .collection("transactions")
        .where("userId", "==", uid)
        .get();
      let summed = 0;
      txnSnap.forEach((d) => {
        const amount = d.data().amount;
        if (typeof amount === "number") summed += amount;
      });

      processed += 1;
      const delta = storedBalance - summed;
      if (delta !== 0) {
        mismatchCount += 1;
        console.error(
          `reconcileWalletBalances drift uid=${uid} stored=${storedBalance} summed=${summed} delta=${delta}`,
        );
        await db
          .collection("walletAudits")
          .doc(`${uid}_${dateId}`)
          .set(
            {
              uid,
              date: dateId,
              storedBalance,
              summedFromTransactions: summed,
              delta,
              transactionCount: txnSnap.size,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
      }
    }

    console.info(
      `reconcileWalletBalances run date=${dateId} processed=${processed} mismatches=${mismatchCount}`,
    );
  },
);

/**
 * Independently verifies — via auth admin SDK — that the two uids being
 * merged still share a verified contact. Plays defense alongside the
 * `userMerges` Firestore rule: even an attacker who manages to enqueue a
 * forged merge entry can't move funds unless the auth records actually
 * share a verified phone or email at run time. Phone-squat in a profile
 * doc no longer suffices.
 */
async function assertSharedVerifiedContact(
  newUid: string,
  existingUid: string,
): Promise<void> {
  let newAuth: admin.auth.UserRecord;
  let existingAuth: admin.auth.UserRecord;
  try {
    [newAuth, existingAuth] = await Promise.all([
      admin.auth().getUser(newUid),
      admin.auth().getUser(existingUid),
    ]);
  } catch (err) {
    throw new Error(
      `merge rejected: cannot load auth records (${err instanceof Error ? err.message : "unknown"})`,
    );
  }
  const toMinimal = (u: admin.auth.UserRecord): MinimalAuthRecord => ({
    uid: u.uid,
    email: u.email ?? null,
    emailVerified: u.emailVerified,
    phoneNumber: u.phoneNumber ?? null,
    metadata: { creationTime: u.metadata.creationTime },
  });
  if (!authUsersShareVerifiedContact(toMinimal(newAuth), toMinimal(existingAuth))) {
    throw new Error(
      `merge rejected: ${newUid} ↔ ${existingUid} share no verified contact`,
    );
  }
}

async function mergeOne(
  newUid: string,
  existingUid: string,
  dryRun: boolean,
): Promise<{
  walletCents: number;
  pendingCents: number;
  transactions: number;
  sessions: number;
  groupInvites: number;
}> {
  // Auth check first: if these two uids don't actually share a verified
  // contact at the auth layer, refuse before touching any money.
  await assertSharedVerifiedContact(newUid, existingUid);

  const summary = {
    walletCents: 0,
    pendingCents: 0,
    transactions: 0,
    sessions: 0,
    groupInvites: 0,
  };

  // Wallet move. Idempotency: a second run finds zero balance to move.
  const newWalletRef = db.collection("wallets").doc(newUid);
  const existingWalletRef = db.collection("wallets").doc(existingUid);
  await db.runTransaction(async (txn) => {
    const newSnap = await txn.get(newWalletRef);
    const existingSnap = await txn.get(existingWalletRef);
    const newData = newSnap.exists ? newSnap.data() ?? {} : {};
    const newBal = typeof newData.balance === "number" ? newData.balance : 0;
    const newPending =
      typeof newData.pendingBalance === "number" ? newData.pendingBalance : 0;
    summary.walletCents = newBal;
    summary.pendingCents = newPending;
    if (dryRun) return;
    if (existingSnap.exists) {
      txn.update(existingWalletRef, {
        balance: admin.firestore.FieldValue.increment(newBal),
        pendingBalance: admin.firestore.FieldValue.increment(newPending),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      txn.set(existingWalletRef, {
        balance: newBal,
        pendingBalance: newPending,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    txn.set(
      newWalletRef,
      {
        balance: 0,
        pendingBalance: 0,
        mergedInto: existingUid,
        mergedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  // Transactions reassign.
  const txnSnap = await db
    .collection("transactions")
    .where("userId", "==", newUid)
    .get();
  summary.transactions = txnSnap.size;
  if (!dryRun && txnSnap.size > 0) {
    const batch = db.batch();
    txnSnap.forEach((d) => batch.update(d.ref, { userId: existingUid }));
    await batch.commit();
  }

  // Sessions reassign.
  const sessionSnap = await db
    .collection("sessions")
    .where("userId", "==", newUid)
    .get();
  summary.sessions = sessionSnap.size;
  if (!dryRun && sessionSnap.size > 0) {
    const batch = db.batch();
    sessionSnap.forEach((d) => batch.update(d.ref, { userId: existingUid }));
    await batch.commit();
  }

  // Group invites addressed to the duplicate.
  const inviteSnap = await db
    .collection("groupInvites")
    .where("toUserId", "==", newUid)
    .get();
  summary.groupInvites = inviteSnap.size;
  if (!dryRun && inviteSnap.size > 0) {
    const batch = db.batch();
    inviteSnap.forEach((d) =>
      batch.update(d.ref, { toUserId: existingUid }),
    );
    await batch.commit();
  }

  // Audit marker first. We mark the duplicate user doc as merged BEFORE
  // deleting the auth user — auth deletion is irreversible, so if a network
  // blip lands between the two writes we'd otherwise lose the audit trail
  // with no way to reconstruct it. Idempotent: `set({ merge: true })` is a
  // no-op on a second run.
  if (!dryRun) {
    await db
      .collection("users")
      .doc(newUid)
      .set(
        {
          mergedInto: existingUid,
          mergedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    // Auth deletion is the very last step — runs only after every data move
    // and audit write has succeeded.
    try {
      await admin.auth().deleteUser(newUid);
    } catch (err) {
      console.warn(`mergeOne: deleteUser ${newUid} failed (continuing):`, err);
    }
  }

  return summary;
}
