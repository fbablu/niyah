import { getAuth, getIdToken } from "@react-native-firebase/auth";
import { getAppCheckToken } from "./appCheck";

const FUNCTIONS_BASE = (
  process.env.EXPO_PUBLIC_FUNCTIONS_URL ||
  `https://us-central1-${process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID}.cloudfunctions.net`
).replace(/\/+$/, "");

const normalizeErrorBody = (status: number, body: string): string => {
  const trimmed = body.trim();

  if (!trimmed) {
    return "Request failed";
  }

  if (/^<!doctype html>|^<html[\s>]/i.test(trimmed)) {
    if (status === 401 || status === 403) {
      return "Function endpoint is not publicly accessible";
    }

    return status === 404
      ? "Function endpoint not found"
      : "Server returned an HTML error page";
  }

  // Cloud Functions respond with { error: "message" }. Extract just the message
  // so users see "Insufficient balance" instead of the raw JSON envelope.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error;
      }
    } catch {
      // Fall through and return the raw body
    }
  }

  return trimmed;
};

// ─── Core fetch wrapper ──────────────────────────────────────────────────────

async function callFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  let idToken: string | null = null;
  try {
    const currentUser = getAuth().currentUser;
    idToken = currentUser ? await getIdToken(currentUser) : null;
  } catch {
    // unauthenticated — server will reject if auth is required
  }

  // App Check token attests this call came from the genuine Niyah binary.
  // Null is acceptable during soft-enforcement rollout.
  const appCheckToken = await getAppCheckToken();

  const response = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      ...(appCheckToken ? { "X-Firebase-AppCheck": appCheckToken } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `[${name}] ${response.status}: ${normalizeErrorBody(response.status, errorBody)}`,
    );
  }

  return response.json() as Promise<T>;
}

// ─── Payment functions ───────────────────────────────────────────────────────

export interface CreatePaymentIntentResult {
  clientSecret: string;
  paymentIntentId: string;
  customerId?: string;
}

/** Amount in cents. */
export async function createPaymentIntent(
  amount: number,
): Promise<CreatePaymentIntentResult> {
  return callFunction<CreatePaymentIntentResult>("createPaymentIntent", {
    amount,
  });
}

export type VerifyDepositResult =
  | { credited: true; newBalance: number; alreadyCredited?: boolean }
  | { processing: true; currentBalance: number; estimatedArrival: string };

/**
 * Verifies a PaymentIntent after PaymentSheet completes.
 * - Card/Apple Pay: credits balance immediately → returns { credited: true, newBalance }
 * - ACH bank debit: payment is still processing → returns { processing: true }
 *   The stripeWebhook will credit the balance when ACH actually clears.
 */
export async function verifyAndCreditDeposit(
  paymentIntentId: string,
): Promise<VerifyDepositResult> {
  return callFunction<VerifyDepositResult>("verifyAndCreditDeposit", {
    paymentIntentId,
  });
}

// ─── Session functions ───────────────────────────────────────────────────────

/**
 * Completes a session server-side. The Cloud Function reads the stakeAmount
 * from the session doc, validates ownership, timer, and status.
 * stakeAmount param is accepted for backwards compatibility but ignored by server.
 */
export async function handleSessionComplete(
  sessionId: string,
  _stakeAmount?: number,
): Promise<{ newBalance: number; payout: number }> {
  return callFunction<{ newBalance: number; payout: number }>(
    "handleSessionComplete",
    { sessionId },
  );
}

export interface SessionForfeitResult {
  success: boolean;
  forgiven?: boolean;
  refundedCents?: number;
}

/**
 * Stake is retained as Niyah revenue unless first-surrender forgiveness
 * applies (up to $5 refund). Server reads amount from session doc.
 */
export async function handleSessionForfeit(
  sessionId: string,
  _stakeAmount?: number,
): Promise<SessionForfeitResult> {
  return callFunction<SessionForfeitResult>("handleSessionForfeit", {
    sessionId,
  });
}

// ─── Stripe Connect functions ────────────────────────────────────────────────

export interface ConnectAccountKycPayload {
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

/**
 * Creates a Stripe Express connected account for payouts. If a KYC payload
 * is provided, server-side pre-populates the Stripe individual.* fields so
 * the hosted onboarding flow only asks for SSN + phone verification. DOB +
 * address are never stored in Firestore — Stripe holds the sensitive data.
 */
export async function createConnectAccount(
  payload?: ConnectAccountKycPayload,
): Promise<{ accountId: string }> {
  return callFunction<{ accountId: string }>(
    "createConnectAccount",
    (payload ?? {}) as Record<string, unknown>,
  );
}

/**
 * Generates a Stripe onboarding link. The Cloud Function reads the accountId
 * from the user's Firestore doc (not from the client) to prevent spoofing.
 */
export async function createAccountLink(): Promise<{ url: string }> {
  return callFunction<{ url: string }>("createAccountLink", {});
}

export async function getConnectAccountStatus(): Promise<{
  status: "none" | "pending" | "active" | "restricted";
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
  bankName?: string;
  bankMask?: string;
}> {
  return callFunction<{
    status: "none" | "pending" | "active" | "restricted";
    chargesEnabled?: boolean;
    payoutsEnabled?: boolean;
    detailsSubmitted?: boolean;
    bankName?: string;
    bankMask?: string;
  }>("getConnectAccountStatus", {});
}

// ─── Plaid bank connection functions ────────────────────────────────────────

/** Creates a Plaid Link token for the client to open the bank-connection UI. */
export async function createPlaidLinkToken(): Promise<{ linkToken: string }> {
  return callFunction<{ linkToken: string }>("createPlaidLinkToken", {});
}

/**
 * Exchanges a Plaid public_token, creates a Stripe Custom connected account,
 * and attaches the bank — all server-side. One-time setup per bank.
 */
export async function linkBankAccount(
  publicToken: string,
  accountId: string,
): Promise<{ success: boolean; bankName: string; bankMask: string }> {
  return callFunction<{ success: boolean; bankName: string; bankMask: string }>(
    "linkBankAccount",
    { publicToken, accountId },
  );
}

/**
 * Detaches the linked bank from Stripe, invalidates the Plaid item, and
 * clears the `linkedBank` field on the user. Idempotent.
 */
export async function unlinkBankAccount(): Promise<{ success: boolean }> {
  return callFunction<{ success: boolean }>("unlinkBankAccount", {});
}

/**
 * Atomic bank swap. New bank is attached and validated first; the old bank
 * is only detached after the new one succeeds. Same response shape as
 * linkBankAccount.
 */
export async function replaceBankAccount(
  publicToken: string,
  accountId: string,
): Promise<{ success: boolean; bankName: string; bankMask: string }> {
  return callFunction<{ success: boolean; bankName: string; bankMask: string }>(
    "replaceBankAccount",
    { publicToken, accountId },
  );
}

export interface WithdrawalResult {
  success: boolean;
  transferId: string;
  payoutId?: string;
  estimatedArrival: string;
}

export interface WithdrawalEligibility {
  completedSessions: number;
  distinctPartners: number;
  requiredSessions: number;
  requiredPartners: number;
  eligible: boolean;
}

/** Progress toward unlocking withdrawal (campus-launch anti-gaming gate). */
export async function getWithdrawalEligibility(): Promise<WithdrawalEligibility> {
  return callFunction<WithdrawalEligibility>("getWithdrawalEligibility", {});
}

// method: 'standard' (free, 1-2 days) | 'instant' (1.5% fee, ~30 min) | 'venmo' (manual, ~24h)
export async function requestWithdrawal(
  amount: number,
  method: "standard" | "instant" | "venmo",
): Promise<WithdrawalResult> {
  return callFunction<WithdrawalResult>("requestWithdrawal", {
    amount,
    method,
  });
}

// ─── Contact discovery functions ────────────────────────────────────────────

export interface ContactMatch {
  uid: string;
  name: string;
  reputation: { score: number; level: string };
}

/**
 * Matches device contacts against Niyah users by phone number and email.
 * Raw contacts are NOT stored server-side — only used for transient matching.
 */
export async function findContactsOnNiyah(
  phones: string[],
  emails: string[],
): Promise<{ matches: ContactMatch[] }> {
  return callFunction<{ matches: ContactMatch[] }>("findContactsOnNiyah", {
    phones,
    emails,
  });
}

// ─── Social functions ────────────────────────────────────────────────────────

/**
 * Awards a referral bonus to the referrer. Runs server-side to prevent
 * clients from manipulating any user's reputation directly.
 */
export async function awardReferral(
  referrerUid: string,
): Promise<{ success: boolean }> {
  return callFunction<{ success: boolean }>("awardReferral", { referrerUid });
}

/**
 * Follows a target user. The Cloud Function ensures only the caller's UID
 * is added to the target's followers array (prevents spoofing).
 */
export async function followUserCF(
  targetUid: string,
): Promise<{ success: boolean }> {
  return callFunction<{ success: boolean }>("followUserFn", { targetUid });
}

/**
 * Unfollows a target user via Cloud Function.
 */
export async function unfollowUserCF(
  targetUid: string,
): Promise<{ success: boolean }> {
  return callFunction<{ success: boolean }>("unfollowUserFn", { targetUid });
}

// ─── Account merge detection ────────────────────────────────────────────────

export type AccountMergeResponse =
  | { status: "no_verified_contact" }
  | { status: "no_match" }
  | { status: "self_match" }
  | {
      status: "merge";
      role: "duplicate";
      canonicalUid: string;
      matchedField: "phone" | "email";
    }
  | {
      status: "merge";
      role: "canonical";
      duplicateUid: string;
      matchedField: "phone" | "email";
    };

/**
 * Server-side duplicate-account detector. Replaces the previous client-side
 * Firestore queries on user phone/email — those leaked an enumeration vector
 * AND trusted user-writable profile fields. The CF uses Firebase Auth admin
 * SDK lookups, which are immune to phone-squat in the Firestore mirror.
 */
export async function requestAccountMerge(): Promise<AccountMergeResponse> {
  return callFunction<AccountMergeResponse>("requestAccountMerge", {});
}

// ─── Legal acceptance functions ──────────────────────────────────────────────

/**
 * Records the user's acceptance of the current legal terms version.
 * The Cloud Function writes `legalAcceptanceVersion` and `legalAcceptedAt`
 * (server timestamp) to the user document for tamper-resistance.
 */
export async function acceptLegalTerms(
  version: string,
): Promise<{ success: boolean }> {
  return callFunction<{ success: boolean }>("acceptLegalTerms", { version });
}

// ─── Group session functions ─────────────────────────────────────────────────

export interface GroupPayoutResult {
  success: boolean;
  transfers: string[];
  payouts: { userId: string; amount: number }[];
}

/**
 * Reconciles group session payouts from the server-recorded completed session.
 * Legacy callers still pass stake/results, but the backend ignores client-
 * supplied payout inputs and settles only from stored session data.
 */
export async function distributeGroupPayouts(
  sessionId: string,
  stakePerParticipant: number,
  results: { userId: string; completed: boolean }[],
): Promise<GroupPayoutResult> {
  return callFunction<GroupPayoutResult>("distributeGroupPayouts", {
    sessionId,
    stakePerParticipant,
    results,
  });
}

// ─── Group session lifecycle functions ──────────────────────────────────────

export interface CreateGroupSessionResult {
  sessionId: string;
  inviteIds: string[];
}

export async function createGroupSession(
  cadence: string,
  stakePerParticipant: number,
  duration: number,
  inviteeIds: string[],
  customStake?: boolean,
): Promise<CreateGroupSessionResult> {
  return callFunction<CreateGroupSessionResult>("createGroupSession", {
    cadence,
    stakePerParticipant,
    duration,
    inviteeIds,
    customStake: customStake ?? false,
  });
}

export async function respondToGroupInvite(
  inviteId: string,
  accept: boolean,
): Promise<{ success: boolean; sessionStatus: string }> {
  return callFunction<{ success: boolean; sessionStatus: string }>(
    "respondToGroupInvite",
    { inviteId, accept },
  );
}

export async function markOnlineForSession(
  sessionId: string,
): Promise<{ success: boolean; allOnline: boolean }> {
  return callFunction<{ success: boolean; allOnline: boolean }>(
    "markOnlineForSession",
    { sessionId },
  );
}

export async function startGroupSessionCF(
  sessionId: string,
): Promise<{ success: boolean; endsAt: number }> {
  return callFunction<{ success: boolean; endsAt: number }>(
    "startGroupSession",
    { sessionId },
  );
}

export async function reportSessionStatus(
  sessionId: string,
  action: "complete" | "surrender",
): Promise<{
  success: boolean;
  sessionComplete: boolean;
  payouts?: Record<string, number>;
}> {
  return callFunction<{
    success: boolean;
    sessionComplete: boolean;
    payouts?: Record<string, number>;
  }>("reportSessionStatus", { sessionId, action });
}

export async function cancelGroupSession(
  sessionId: string,
): Promise<{ success: boolean; refundedCount: number }> {
  return callFunction<{ success: boolean; refundedCount: number }>(
    "cancelGroupSession",
    { sessionId },
  );
}

/**
 * Reports a shield violation (user opened a blocked app during an active
 * group session). Server increments the participant's violationCount and
 * sends an FCM push to other participants.
 */
export async function reportShieldViolation(
  sessionId: string,
): Promise<{ success: boolean; violationCount: number }> {
  return callFunction<{ success: boolean; violationCount: number }>(
    "reportShieldViolation",
    { sessionId },
  );
}
