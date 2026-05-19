/**
 * Firebase configuration layer.
 *
 * Uses the RNFB **modular API** (v22+ compatible) to avoid deprecation
 * warnings from the namespaced API. See:
 * https://rnfirebase.io/migrating-to-v22
 */

import {
  getAuth,
  signInWithCredential,
  sendSignInLinkToEmail,
  isSignInWithEmailLink as rnfbIsSignInWithEmailLink,
  signInWithEmailLink as rnfbSignInWithEmailLink,
  signOut as rnfbSignOut,
  onAuthStateChanged as rnfbOnAuthStateChanged,
  GoogleAuthProvider,
  AppleAuthProvider,
  signInWithPhoneNumber as rnfbSignInWithPhoneNumber,
} from "@react-native-firebase/auth";
import type { FirebaseAuthTypes } from "@react-native-firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc as firestoreUpdateDoc,
  query,
  where,
  limit,
  getDocs,
  serverTimestamp,
  Timestamp,
  onSnapshot,
} from "@react-native-firebase/firestore";
import type { FirebaseFirestoreTypes } from "@react-native-firebase/firestore";
import {
  GoogleSignin,
  isSuccessResponse,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import * as Linking from "expo-linking";
import * as Crypto from "expo-crypto";
import { logger } from "../utils/logger";
import { createErrorWithCode, getErrorCode } from "../utils/errors";

// ---------------------------------------------------------------------------
// Firestore collection name constants
// ---------------------------------------------------------------------------

const COLLECTIONS = {
  USERS: "users",
  WALLETS: "wallets",
  USER_FOLLOWS: "userFollows",
  SESSIONS: "sessions",
  GROUP_SESSIONS: "groupSessions",
  GROUP_INVITES: "groupInvites",
} as const;

// ---------------------------------------------------------------------------
// FirebaseUser type — compatible interface used by the rest of the app.
// Maps from RNFB's FirebaseAuthTypes.User / UserCredential.
// ---------------------------------------------------------------------------

export interface FirebaseUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  phoneNumber: string | null;
  providerId: string | null;
  isNewUser: boolean;
}

const mapUser = (
  rnfbUser: FirebaseAuthTypes.User,
  isNewUser: boolean = false,
): FirebaseUser => ({
  uid: rnfbUser.uid,
  email: rnfbUser.email,
  displayName: rnfbUser.displayName,
  photoURL: rnfbUser.photoURL,
  phoneNumber: rnfbUser.phoneNumber,
  providerId: rnfbUser.providerId,
  isNewUser,
});

// ---------------------------------------------------------------------------
// Singleton instances (modular API)
// ---------------------------------------------------------------------------

const authInstance = getAuth();
const db = getFirestore();

// ---------------------------------------------------------------------------
// Google Sign-In configuration
// ---------------------------------------------------------------------------

GoogleSignin.configure({
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  offlineAccess: true,
});

// ---------------------------------------------------------------------------
// Google Sign-In
// ---------------------------------------------------------------------------

export const signInWithGoogle = async (): Promise<FirebaseUser> => {
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

  try {
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) {
      throw createErrorWithCode(
        "Google Sign-In was cancelled",
        statusCodes.SIGN_IN_CANCELLED,
      );
    }

    const idToken = response.data?.idToken;
    if (!idToken) {
      throw new Error("Failed to get ID token from Google");
    }

    const credential = GoogleAuthProvider.credential(idToken);
    const result = await signInWithCredential(authInstance, credential);
    return mapUser(result.user, result.additionalUserInfo?.isNewUser ?? false);
  } catch (error) {
    if (getErrorCode(error) === statusCodes.SIGN_IN_CANCELLED) {
      throw createErrorWithCode(
        "Google Sign-In was cancelled",
        statusCodes.SIGN_IN_CANCELLED,
      );
    }

    throw error;
  }
};

export const signOutGoogle = async () => {
  try {
    await GoogleSignin.signOut();
  } catch (error) {
    logger.error("Google Sign-Out error:", error);
  }
};

// ---------------------------------------------------------------------------
// Nonce helpers (required for Apple Sign-In with Firebase)
// ---------------------------------------------------------------------------

export const generateNonce = async (): Promise<string> => {
  const randomBytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

export const sha256 = async (input: string): Promise<string> => {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);
};

// ---------------------------------------------------------------------------
// Apple Sign-In
// ---------------------------------------------------------------------------

export const signInWithApple = async (
  identityToken: string,
  rawNonce: string,
): Promise<FirebaseUser> => {
  const credential = AppleAuthProvider.credential(identityToken, rawNonce);
  const result = await signInWithCredential(authInstance, credential);
  return mapUser(result.user, result.additionalUserInfo?.isNewUser ?? false);
};

// ---------------------------------------------------------------------------
// Email magic link (passwordless)
// ---------------------------------------------------------------------------

const MAGIC_LINK_REDIRECT_URL = Linking.createURL("auth/email-callback");

export const sendMagicLink = async (email: string): Promise<void> => {
  await sendSignInLinkToEmail(authInstance, email, {
    url: MAGIC_LINK_REDIRECT_URL,
    handleCodeInApp: true,
    iOS: { bundleId: "com.niyah.app" },
    android: { packageName: "com.niyah.app", installApp: false },
  });
};

export const isEmailSignInLink = (url: string): Promise<boolean> => {
  return rnfbIsSignInWithEmailLink(authInstance, url);
};

export const signInWithEmailLink = async (
  email: string,
  url: string,
): Promise<FirebaseUser> => {
  const result = await rnfbSignInWithEmailLink(authInstance, email, url);
  return mapUser(result.user, result.additionalUserInfo?.isNewUser ?? false);
};

// ---------------------------------------------------------------------------
// Phone auth (SMS verification)
// ---------------------------------------------------------------------------

export type PhoneConfirmationResult = FirebaseAuthTypes.ConfirmationResult;

/**
 * Send an SMS verification code to the given phone number.
 * Returns a ConfirmationResult that can be used to verify the code.
 * Phone number must be in E.164 format (e.g. "+12025551234").
 */
export const sendPhoneVerification = async (
  phoneNumber: string,
): Promise<PhoneConfirmationResult> => {
  return rnfbSignInWithPhoneNumber(authInstance, phoneNumber);
};

/**
 * Verify an SMS code and sign in the user.
 * Returns a mapped FirebaseUser.
 */
export const confirmPhoneCode = async (
  confirmation: PhoneConfirmationResult,
  code: string,
): Promise<FirebaseUser> => {
  const result = await confirmation.confirm(code);
  if (!result) {
    throw new Error("Phone verification failed — no user returned");
  }
  return mapUser(result.user, result.additionalUserInfo?.isNewUser ?? false);
};

// ---------------------------------------------------------------------------
// Firebase Auth helpers
// ---------------------------------------------------------------------------

export const signOut = async (): Promise<void> => {
  await signOutGoogle();
  await rnfbSignOut(authInstance);
};

export const onAuthStateChanged = (
  callback: (user: FirebaseUser | null) => void,
): (() => void) => {
  return rnfbOnAuthStateChanged(authInstance, (rnfbUser) => {
    callback(rnfbUser ? mapUser(rnfbUser) : null);
  });
};

// ---------------------------------------------------------------------------
// Firestore helpers
// ---------------------------------------------------------------------------

export const getUserDoc = async (
  uid: string,
): Promise<Record<string, unknown> | null> => {
  const snap = await getDoc(doc(db, COLLECTIONS.USERS, uid));
  if (!snap.exists) return null;
  return { __id: snap.id, ...snap.data() } as Record<string, unknown>;
};

export const saveUserProfile = async (
  uid: string,
  data: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    profileImage?: string;
    blobAvatar?: {
      colorPreset: "sunset" | "ocean" | "forest" | "berry" | "lemon" | "coral";
      shapePreset: "peach" | "wave" | "petal";
      eyesPreset: "classic" | "happy" | "wink" | "sleepy" | "surprised";
    };
    authProvider: "google" | "apple" | "email" | "phone";
  },
): Promise<void> => {
  const serverTs = serverTimestamp();

  // Pull canonical contact + display fields directly from auth so the
  // Firestore doc never disagrees with Firebase Auth (the source of truth
  // for verified phone/email). Anything passed in via `data` is only used
  // as a fallback for providers that don't surface that field.
  const authUser = authInstance.currentUser;
  const canonicalEmail = authUser?.email || data.email || "";
  const canonicalPhone = authUser?.phoneNumber || data.phone || undefined;
  const canonicalPhotoURL =
    authUser?.photoURL || data.profileImage || undefined;

  const payload: Record<string, unknown> = {
    firstName: data.firstName,
    lastName: data.lastName,
    email: canonicalEmail,
    phone: canonicalPhone,
    profileImage: canonicalPhotoURL,
    blobAvatar: data.blobAvatar,
    authProvider: data.authProvider,
    name: `${data.firstName} ${data.lastName}`.trim(),
    profileComplete: true,
    createdAt: serverTs,
    updatedAt: serverTs,
    reputation: {
      score: 50,
      level: "sapling",
      paymentsCompleted: 0,
      paymentsMissed: 0,
      totalOwedPaid: 0,
      totalOwedMissed: 0,
    },
    stats: {
      currentStreak: 0,
      longestStreak: 0,
      totalSessions: 0,
      completedSessions: 0,
      totalEarnings: 0,
    },
  };

  // Strip undefined values — Firestore rejects them.
  const cleanPayload = Object.fromEntries(
    Object.entries(payload).filter(([, v]) => v !== undefined),
  );

  await setDoc(doc(db, COLLECTIONS.USERS, uid), cleanPayload, { merge: true });

  const walletSnap = await getDoc(doc(db, COLLECTIONS.WALLETS, uid));

  if (!walletSnap.exists) {
    await setDoc(doc(db, COLLECTIONS.WALLETS, uid), {
      balance: 0,
      pendingBalance: 0,
      lastUpdated: serverTs,
    });
  }
};

export const fetchUserProfile = async (
  uid: string,
): Promise<Record<string, unknown> | null> => {
  return getUserDoc(uid);
};

/**
 * Awards a referral bonus to the referrer.
 *
 * SECURITY: Delegates to the awardReferral Cloud Function, which uses the
 * admin SDK to write to the referrer's document. The previous client-side
 * implementation allowed any authenticated user to modify any user's
 * reputation field directly via a permissive Firestore rule.
 *
 * Fire-and-forget safe — errors are swallowed so the caller's flow is unaffected.
 */
export const awardReferralToUser = async (
  referrerUid: string,
): Promise<void> => {
  try {
    const { awardReferral } = require("./functions");
    await awardReferral(referrerUid);
  } catch (error) {
    logger.warn("awardReferralToUser failed (non-critical):", error);
  }
};

// ---------------------------------------------------------------------------
// Social / follows helpers — uses batch writes for atomicity
// ---------------------------------------------------------------------------

interface FollowsDoc {
  following: string[];
  followers: string[];
}

export const getFollowsDoc = async (uid: string): Promise<FollowsDoc> => {
  const snap = await getDoc(doc(db, COLLECTIONS.USER_FOLLOWS, uid));
  if (!snap.exists) return { following: [], followers: [] };
  const data = snap.data() ?? {};
  return {
    following: (data.following as string[]) ?? [],
    followers: (data.followers as string[]) ?? [],
  };
};

/**
 * Follows a target user via Cloud Function.
 *
 * SECURITY: Delegates to the followUserFn Cloud Function, which uses the
 * admin SDK. The previous client-side batch write allowed any authenticated
 * user to inject/remove arbitrary UIDs in another user's followers array
 * via an overly permissive Firestore rule.
 *
 * The myUid parameter is kept for API compatibility but is NOT sent to the
 * server — the Cloud Function uses the authenticated caller's UID.
 */
export const followUser = async (
  _myUid: string,
  targetUid: string,
): Promise<void> => {
  const { followUserCF } = require("./functions");
  await followUserCF(targetUid);
};

/**
 * Unfollows a target user via Cloud Function.
 * See followUser for security rationale.
 */
export const unfollowUser = async (
  _myUid: string,
  targetUid: string,
): Promise<void> => {
  const { unfollowUserCF } = require("./functions");
  await unfollowUserCF(targetUid);
};

export const getPublicProfile = async (
  uid: string,
): Promise<{
  uid: string;
  name: string;
  reputation: { score: number; level: string; referralCount: number };
  currentStreak: number;
  totalSessions: number;
  completedSessions: number;
} | null> => {
  const docData = await fetchUserProfile(uid);
  if (!docData) return null;

  const rep = (docData.reputation as Record<string, unknown>) ?? {};
  const stats = (docData.stats as Record<string, number>) ?? {};

  return {
    uid,
    name: (docData.name as string) || "",
    reputation: {
      score: (rep.score as number) ?? 50,
      level: (rep.level as string) ?? "sapling",
      referralCount: (rep.referralCount as number) ?? 0,
    },
    currentStreak: stats.currentStreak ?? 0,
    totalSessions: stats.totalSessions ?? 0,
    completedSessions: stats.completedSessions ?? 0,
  };
};

// ---------------------------------------------------------------------------
// Partial user doc update — for syncing stats, reputation, handles, etc.
// Uses set+merge so missing fields are not deleted.
// ---------------------------------------------------------------------------

export const updateUserDoc = async (
  uid: string,
  data: Record<string, unknown>,
): Promise<void> => {
  await setDoc(
    doc(db, COLLECTIONS.USERS, uid),
    { ...data, updatedAt: serverTimestamp() },
    { merge: true },
  );
};

// ---------------------------------------------------------------------------
// Wallet — read server-authoritative balance
// ---------------------------------------------------------------------------

export const getWalletDoc = async (
  uid: string,
): Promise<{ balance: number; pendingBalance: number } | null> => {
  const snap = await getDoc(doc(db, COLLECTIONS.WALLETS, uid));
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  return {
    balance: (data.balance as number) ?? 0,
    pendingBalance: (data.pendingBalance as number) ?? 0,
  };
};

/**
 * Subscribe to wallet document changes. Fires callback on every update.
 * Returns unsubscribe function.
 */
export const subscribeToWallet = (
  uid: string,
  callback: (data: { balance: number; pendingBalance: number } | null) => void,
): (() => void) => {
  const docRef = doc(db, COLLECTIONS.WALLETS, uid);
  return onSnapshot(docRef, (snap) => {
    if (!snap.exists) {
      callback(null);
      return;
    }
    const data = snap.data() ?? {};
    callback({
      balance: (data.balance as number) ?? 0,
      pendingBalance: (data.pendingBalance as number) ?? 0,
    });
  });
};

// ---------------------------------------------------------------------------
// Session persistence — write/read solo session documents
// ---------------------------------------------------------------------------

export interface SessionDoc {
  userId: string;
  cadence: string;
  stakeAmount: number;
  potentialPayout: number;
  startedAt: FirebaseFirestoreTypes.Timestamp;
  endsAt: FirebaseFirestoreTypes.Timestamp;
  status: string;
  completedAt?: FirebaseFirestoreTypes.Timestamp;
  actualPayout?: number;
}

export const writeSession = async (
  sessionId: string,
  data: {
    userId: string;
    cadence: string;
    stakeAmount: number;
    potentialPayout: number;
    startedAt: Date;
    endsAt: Date;
    status: string;
  },
): Promise<void> => {
  await setDoc(doc(db, COLLECTIONS.SESSIONS, sessionId), {
    ...data,
    startedAt: Timestamp.fromDate(data.startedAt),
    endsAt: Timestamp.fromDate(data.endsAt),
    createdAt: serverTimestamp(),
  });
};

export const updateSession = async (
  sessionId: string,
  data: {
    status: string;
    completedAt?: Date;
    violationCount?: number;
  },
): Promise<void> => {
  const updateData: Record<string, unknown> = {
    status: data.status,
    updatedAt: serverTimestamp(),
  };
  if (data.completedAt) {
    updateData.completedAt = Timestamp.fromDate(data.completedAt);
  }
  if (data.violationCount !== undefined) {
    updateData.violationCount = data.violationCount;
  }
  // actualPayout is written exclusively by Cloud Functions (admin SDK).
  // Client writes to this field are blocked by Firestore security rules.
  await firestoreUpdateDoc(
    doc(db, COLLECTIONS.SESSIONS, sessionId),
    updateData,
  );
};

/** Fetch the active session for a user (crash recovery). Returns null if none. */
export const getActiveSession = async (
  userId: string,
): Promise<{
  id: string;
  cadence: string;
  stakeAmount: number;
  potentialPayout: number;
  startedAt: Date;
  endsAt: Date;
  status: string;
} | null> => {
  const q = query(
    collection(db, COLLECTIONS.SESSIONS),
    where("userId", "==", userId),
    where("status", "==", "active"),
    limit(1),
  );
  const snap = await getDocs(q);

  if (snap.empty) return null;

  const docSnap = snap.docs[0];
  const data = docSnap.data();
  return {
    id: docSnap.id,
    cadence: data.cadence as string,
    stakeAmount: data.stakeAmount as number,
    potentialPayout: data.potentialPayout as number,
    startedAt: (data.startedAt as FirebaseFirestoreTypes.Timestamp).toDate(),
    endsAt: (data.endsAt as FirebaseFirestoreTypes.Timestamp).toDate(),
    status: data.status as string,
  };
};

// ---------------------------------------------------------------------------
// Group session real-time listeners
// ---------------------------------------------------------------------------

/**
 * Subscribe to a group session document. Fires callback on every change.
 * Returns unsubscribe function.
 */
export const subscribeToGroupSession = (
  sessionId: string,
  callback: (data: Record<string, unknown> | null) => void,
): (() => void) => {
  const docRef = doc(db, COLLECTIONS.GROUP_SESSIONS, sessionId);
  return onSnapshot(docRef, (snap) => {
    if (!snap.exists) {
      callback(null);
      return;
    }
    callback({ __id: snap.id, ...snap.data() } as Record<string, unknown>);
  });
};

/**
 * Subscribe to pending invites for a user. Fires callback with full list
 * on every change. Returns unsubscribe function.
 */
export const subscribeToGroupInvites = (
  userId: string,
  callback: (invites: Array<Record<string, unknown>>) => void,
): (() => void) => {
  const q = query(
    collection(db, COLLECTIONS.GROUP_INVITES),
    where("toUserId", "==", userId),
    where("status", "==", "pending"),
  );
  return onSnapshot(q, (snap) => {
    if (!snap) return callback([]);
    const invites = snap.docs.map(
      (d: FirebaseFirestoreTypes.QueryDocumentSnapshot) => ({
        __id: d.id,
        ...d.data(),
      }),
    ) as Array<Record<string, unknown>>;
    callback(invites);
  });
};

/**
 * Subscribe to all active/ready group sessions where user is a participant.
 * Returns unsubscribe function.
 */
export const subscribeToActiveGroupSessions = (
  userId: string,
  callback: (sessions: Array<Record<string, unknown>>) => void,
): (() => void) => {
  const q = query(
    collection(db, COLLECTIONS.GROUP_SESSIONS),
    where("participantIds", "array-contains", userId),
    where("status", "in", ["pending", "ready", "active"]),
  );
  return onSnapshot(q, (snap) => {
    if (!snap) return callback([]);
    const sessions = snap.docs.map(
      (d: FirebaseFirestoreTypes.QueryDocumentSnapshot) => ({
        __id: d.id,
        ...d.data(),
      }),
    ) as Array<Record<string, unknown>>;
    callback(sessions);
  });
};

/** Fetch a single group session by ID (one-off read). */
export const getGroupSession = async (
  sessionId: string,
): Promise<Record<string, unknown> | null> => {
  const snap = await getDoc(doc(db, COLLECTIONS.GROUP_SESSIONS, sessionId));
  if (!snap.exists) return null;
  return { __id: snap.id, ...snap.data() } as Record<string, unknown>;
};
