/**
 * Multi-provider account linking — client side.
 *
 * Duplicate-account detection has been moved server-side
 * (`requestAccountMerge` Cloud Function). The CF performs admin-SDK auth
 * lookups by verified phone/email, which:
 *   1. Prevents enumeration: clients can't query the users collection by
 *      phone or email to discover who has signed up.
 *   2. Prevents phone-squat takeover: the match uses Firebase Auth's
 *      OTP-verified `phoneNumber` (server-controlled), not the
 *      user-writable `users/{uid}.phone` Firestore mirror.
 *
 * This module exposes a thin wrapper plus the in-app provider link helper
 * (which uses Firebase's native `linkWithCredential` while the user is
 * already signed in — that's the canonical "Connect Google" flow).
 */

import {
  getAuth,
  GoogleAuthProvider,
  AppleAuthProvider,
  linkWithCredential,
} from "@react-native-firebase/auth";
import {
  requestAccountMerge as requestAccountMergeCF,
  type AccountMergeResponse,
} from "../config/functions";
import { logger } from "./logger";

export type LinkProvider = "google" | "apple" | "phone" | "email";

/**
 * Asks the server whether the just-signed-in user is a duplicate of an
 * existing account. The server enforces the trust boundary and (when this
 * caller is the duplicate) writes the `userMerges` queue via admin SDK so a
 * `mergeDuplicateUsers` run can finalize the swap.
 *
 * Errors are swallowed: a transient failure here must not block sign-in.
 * The next sign-in retries.
 */
export async function checkForAccountMerge(): Promise<AccountMergeResponse | null> {
  try {
    return await requestAccountMergeCF();
  } catch (err) {
    logger.warn("requestAccountMerge failed (non-blocking):", err);
    return null;
  }
}

/**
 * True account linking via Firebase. Adds the supplied credential to the
 * currently-signed-in auth user so that user can subsequently sign in via
 * either provider and land on the same uid. Used by the in-app "Connect
 * Google" / "Connect Apple" affordance (future).
 */
export async function linkProviderToCurrentUser(opts: {
  provider: "google" | "apple";
  idToken: string;
  rawNonce?: string;
}): Promise<string> {
  const auth = getAuth();
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("Must be signed in to link a provider");

  const credential =
    opts.provider === "google"
      ? GoogleAuthProvider.credential(opts.idToken)
      : AppleAuthProvider.credential(opts.idToken, opts.rawNonce ?? "");

  const result = await linkWithCredential(currentUser, credential);
  return result.user.uid;
}
