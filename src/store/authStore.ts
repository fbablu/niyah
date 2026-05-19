import { create } from "zustand";
import { User, UserReputation } from "../types";
import {
  onAuthStateChanged,
  signOut,
  signInWithGoogle,
  signInWithApple,
  sendMagicLink,
  signInWithEmailLink,
  isEmailSignInLink,
  sendPhoneVerification,
  confirmPhoneCode,
  saveUserProfile,
  fetchUserProfile,
  updateUserDoc,
  type FirebaseUser,
  type PhoneConfirmationResult,
} from "../config/firebase";
import * as SecureStore from "expo-secure-store";
import {
  REFERRAL_REPUTATION_BOOST,
  CURRENT_LEGAL_VERSION,
  DEMO_MODE,
} from "../constants/config";
import {
  generateBlobAvatarPreset,
  normalizeBlobAvatarConfig,
  type BlobAvatarConfig,
} from "../constants/blobAvatar";
import { logger } from "../utils/logger";
import { logEvent } from "../utils/analytics";
import { setSentryUser } from "../config/sentry";
import {
  checkOtpThrottle,
  recordOtpSent,
  recordHardLockout,
  clearOtpThrottle,
  formatRetryAfter,
} from "../utils/otpThrottle";
import {
  checkForAccountMerge,
  type LinkProvider,
} from "../utils/accountLinking";

// Detect cross-provider duplicate accounts and enqueue an admin-side merge.
// Runs after Firebase Auth completes but before profile is built so the
// rest of the flow doesn't have to know whether the uid is canonical or a
// soon-to-be-merged duplicate.
//
// All trust is server-side: `requestAccountMerge` uses Firebase Auth's
// verified phone/email (OTP / email-link verified) and ignores the
// user-writable Firestore mirror. The client only acts on the response.
async function tryQueueAccountMerge(
  firebaseUser: FirebaseUser,
  firestoreData: Record<string, unknown> | null,
  newAuthProvider: LinkProvider,
): Promise<void> {
  // Only ask the server when this looks like a fresh Firebase user. Returning
  // users with a profile doc don't need a duplicate check on every sign-in.
  const hasProfile = !!firestoreData;
  if (hasProfile && !firebaseUser.isNewUser) return;

  const response = await checkForAccountMerge();
  if (!response) return;

  if (response.status === "merge") {
    logger.warn(
      `account_link_candidate: uid=${firebaseUser.uid} role=${response.role} via=${response.matchedField}`,
    );
    logEvent("account_merge_queued", {
      role: response.role,
      matchedField: response.matchedField,
      newAuthProvider,
    });
  }
}

// Lazy import to break circular dependency (walletStore imports authStore)
const hydrateWallet = (uid: string) => {
  const { useWalletStore } = require("./walletStore") as {
    useWalletStore: { getState: () => { hydrate: (uid: string) => void } };
  };
  useWalletStore.getState().hydrate(uid);
};

// Lazy import for session recovery on login
const recoverSession = (uid: string) => {
  const { useSessionStore } = require("./sessionStore") as {
    useSessionStore: {
      getState: () => { recoverActiveSession: (uid: string) => void };
    };
  };
  useSessionStore.getState().recoverActiveSession(uid);
};

// Lazy import for notification setup on login
const initNotifications = () => {
  const { initializeNotifications } = require("../config/notifications") as {
    initializeNotifications: () => Promise<() => void>;
  };
  return initializeNotifications();
};

// Lazy import for notification cleanup on logout
const cleanupNotifications = (uid: string) => {
  const { removeFCMToken, resetNotifications } =
    require("../config/notifications") as {
      removeFCMToken: (uid: string) => Promise<void>;
      resetNotifications: () => void;
    };
  resetNotifications();
  return removeFCMToken(uid);
};

// Lazy import for group session recovery
const recoverGroupSessions = (uid: string) => {
  try {
    const { useGroupSessionStore } = require("./groupSessionStore") as {
      useGroupSessionStore: {
        getState: () => {
          subscribeToInvites: (uid: string) => void;
          subscribeToActiveSessions: (uid: string) => void;
        };
      };
    };
    const store = useGroupSessionStore.getState();
    store.subscribeToInvites(uid);
    store.subscribeToActiveSessions(uid);
  } catch (err) {
    // Non-critical: group session subscriptions can fail without blocking auth
    logger.warn("Failed to subscribe to group sessions:", err);
  }
};

const MAGIC_LINK_EMAIL_KEY = "@niyah/magic_link_email";

interface AuthState {
  user: User | null;
  firebaseUser: FirebaseUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isInitialized: boolean; // true once first onAuthStateChanged fires
  isSigningOut: boolean;
  profileComplete: boolean;
  isNewUser: boolean;
  hasAcceptedCurrentLegal: boolean;

  initialize: () => () => void; // returns unsubscribe function
  loginWithGoogle: () => Promise<void>;
  loginWithApple: (
    identityToken: string,
    rawNonce: string,
    name?: string,
    email?: string,
  ) => Promise<void>;
  sendEmailLink: (email: string) => Promise<void>;
  completeEmailLink: (url: string) => Promise<void>;
  sendPhoneCode: (phoneNumber: string) => Promise<void>;
  verifyPhoneCode: (code: string) => Promise<void>;
  phoneConfirmation: PhoneConfirmationResult | null;
  completeProfile: (data: {
    firstName: string;
    lastName: string;
    phone?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (updates: Partial<User>) => void;
  updateReputation: (updates: Partial<UserReputation>) => void;
  setVenmoHandle: (handle: string) => void;
  setZelleHandle: (handle: string) => void;
  setBlobAvatar: (blobAvatar: BlobAvatarConfig) => void;
  acceptLegal: () => Promise<void>;
}

const createInitialReputation = (): UserReputation => ({
  score: 50,
  level: "sapling",
  paymentsCompleted: 0,
  paymentsMissed: 0,
  totalOwedPaid: 0,
  totalOwedMissed: 0,
  lastUpdated: new Date(),
  referralCount: 0,
});

const getReputationLevel = (score: number): UserReputation["level"] => {
  if (score <= 20) return "seed";
  if (score <= 40) return "sprout";
  if (score <= 60) return "sapling";
  if (score <= 80) return "tree";
  return "oak";
};

// Firestore stores dates as Timestamp objects (with .toDate()), but REST/JSON
// paths can deliver numbers or ISO strings. Normalize all shapes to a Date.
const toDateSafe = (value: unknown): Date | undefined => {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as { toDate: () => Date }).toDate === "function"
  ) {
    try {
      return (value as { toDate: () => Date }).toDate();
    } catch {
      return undefined;
    }
  }
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
};

const buildUser = (
  firebaseUser: FirebaseUser,
  firestoreData: Record<string, unknown> | null,
): User => {
  if (firestoreData) {
    const rep = (firestoreData.reputation as Partial<UserReputation>) || {};
    const stats = (firestoreData.stats as Record<string, number>) || {};
    return {
      id: firebaseUser.uid,
      email: firebaseUser.email || "",
      name: (firestoreData.name as string) || firebaseUser.displayName || "",
      firstName: firestoreData.firstName as string | undefined,
      lastName: firestoreData.lastName as string | undefined,
      profileImage:
        (firestoreData.profileImage as string) ||
        firebaseUser.photoURL ||
        undefined,
      blobAvatar: normalizeBlobAvatarConfig(
        firestoreData.blobAvatar as Partial<BlobAvatarConfig> | undefined,
        firebaseUser.uid,
      ),
      balance: 0, // Wallet is separate (walletStore)
      currentStreak: stats.currentStreak || 0,
      longestStreak: stats.longestStreak || 0,
      totalSessions: stats.totalSessions || 0,
      completedSessions: stats.completedSessions || 0,
      totalEarnings: stats.totalEarnings || 0,
      createdAt: toDateSafe(firestoreData.createdAt) ?? new Date(),
      reputation: {
        score: rep.score ?? 50,
        level: rep.level || "sapling",
        paymentsCompleted: rep.paymentsCompleted || 0,
        paymentsMissed: rep.paymentsMissed || 0,
        totalOwedPaid: rep.totalOwedPaid || 0,
        totalOwedMissed: rep.totalOwedMissed || 0,
        lastUpdated: new Date(),
        referralCount: rep.referralCount || 0,
      },
      venmoHandle: firestoreData.venmoHandle as string | undefined,
      zelleHandle: firestoreData.zelleHandle as string | undefined,
      // Prefer Firebase Auth as source of truth — Firestore mirror is
      // best-effort and can be stale after re-auth flows. Falls back to the
      // mirrored field only when auth doesn't carry a phone (e.g. user
      // signed up via Google before adding a phone).
      phoneNumber:
        firebaseUser.phoneNumber || (firestoreData.phone as string | undefined),
      authProvider: firestoreData.authProvider as
        | "email"
        | "google"
        | "apple"
        | undefined,
      profileComplete: firestoreData.profileComplete === true,
      stripeAccountId: firestoreData.stripeAccountId as string | undefined,
      stripeCustomerId: firestoreData.stripeCustomerId as string | undefined,
      stripeAccountStatus: firestoreData.stripeAccountStatus as
        | "pending"
        | "active"
        | "restricted"
        | undefined,
      legalAcceptanceVersion: firestoreData.legalAcceptanceVersion as
        | string
        | undefined,
      legalAcceptedAt: toDateSafe(firestoreData.legalAcceptedAt),
      legalFirstName: firestoreData.legalFirstName as string | undefined,
      legalLastName: firestoreData.legalLastName as string | undefined,
      stripeKycProvidedAt: toDateSafe(firestoreData.stripeKycProvidedAt),
      linkedBank: firestoreData.linkedBank as
        | { institutionName: string; bankName: string; mask: string }
        | undefined,
      firstSurrenderForgiven: firestoreData.firstSurrenderForgiven === true,
      firstSurrenderForgivenAt: toDateSafe(
        firestoreData.firstSurrenderForgivenAt,
      ),
      finalsPromoAwarded: firestoreData.finalsPromoAwarded === true,
      finalsPromoAwardedAt: toDateSafe(firestoreData.finalsPromoAwardedAt),
    };
  }

  return {
    id: firebaseUser.uid,
    email: firebaseUser.email || "",
    name: firebaseUser.displayName || "",
    profileImage: firebaseUser.photoURL || undefined,
    blobAvatar: generateBlobAvatarPreset(firebaseUser.uid),
    balance: 0,
    currentStreak: 0,
    longestStreak: 0,
    totalSessions: 0,
    completedSessions: 0,
    totalEarnings: 0,
    createdAt: new Date(),
    reputation: createInitialReputation(),
    authProvider: "email",
    profileComplete: false,
  };
};

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  firebaseUser: null,
  isAuthenticated: false,
  isLoading: false,
  isInitialized: false,
  profileComplete: false,
  isNewUser: false,
  isSigningOut: false,
  hasAcceptedCurrentLegal: false,

  initialize: () => {
    const unsubscribe = onAuthStateChanged(async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const firestoreData = await fetchUserProfile(firebaseUser.uid);
          const user = buildUser(firebaseUser, firestoreData);
          const profileComplete = user.profileComplete === true;

          set({
            firebaseUser,
            user,
            isAuthenticated: true,
            isInitialized: true,
            profileComplete,
            hasAcceptedCurrentLegal:
              user.legalAcceptanceVersion === CURRENT_LEGAL_VERSION,
            isLoading: false,
          });

          setSentryUser({ id: user.id, email: user.email });
          logEvent("auth_complete", {
            provider: user.authProvider ?? "unknown",
            profileComplete,
          });

          // Hydrate wallet and recover any active session (non-blocking)
          hydrateWallet(firebaseUser.uid);
          recoverSession(firebaseUser.uid);

          // Initialize FCM notifications and subscribe to group session data
          initNotifications().catch((err) =>
            logger.error("Failed to init notifications:", err),
          );
          recoverGroupSessions(firebaseUser.uid);
        } catch (error) {
          logger.error("Error fetching user profile:", error);
          // Still mark as authenticated even if Firestore fetch fails
          const user = buildUser(firebaseUser, null);
          set({
            firebaseUser,
            user,
            isAuthenticated: true,
            isInitialized: true,
            profileComplete: false,
            hasAcceptedCurrentLegal: false,
            isLoading: false,
          });

          // Still try to hydrate wallet even if profile fetch failed
          hydrateWallet(firebaseUser.uid);
          recoverSession(firebaseUser.uid);

          // Initialize FCM notifications and subscribe to group session data
          initNotifications().catch((err) =>
            logger.error("Failed to init notifications:", err),
          );
          recoverGroupSessions(firebaseUser.uid);
        }
      } else {
        setSentryUser(null);
        set({
          firebaseUser: null,
          user: null,
          isAuthenticated: false,
          isInitialized: true,
          profileComplete: false,
          hasAcceptedCurrentLegal: false,
          isNewUser: false,
          isLoading: false,
        });
      }
    });

    return unsubscribe;
  },

  loginWithGoogle: async () => {
    set({ isLoading: true });

    try {
      const firebaseUser = await signInWithGoogle();

      // Fetch Firestore profile and build user state immediately,
      // rather than waiting for onAuthStateChanged (which races).
      const firestoreData = await fetchUserProfile(firebaseUser.uid).catch(
        () => null,
      );
      await tryQueueAccountMerge(firebaseUser, firestoreData, "google");
      const user = buildUser(firebaseUser, firestoreData);
      const profileComplete = user.profileComplete === true;

      set({
        firebaseUser,
        user,
        isAuthenticated: true,
        profileComplete,
        hasAcceptedCurrentLegal:
          user.legalAcceptanceVersion === CURRENT_LEGAL_VERSION,
        isNewUser: !profileComplete,
        isLoading: false,
      });

      // Hydrate wallet and recover session (non-blocking).
      // Notifications + group session subscriptions are set up by `initialize()`
      // when onAuthStateChanged fires — avoid stacking listeners here.
      hydrateWallet(firebaseUser.uid);
      recoverSession(firebaseUser.uid);
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  loginWithApple: async (
    identityToken: string,
    rawNonce: string,
    _name?: string,
    _email?: string,
  ) => {
    set({ isLoading: true });

    try {
      const firebaseUser = await signInWithApple(identityToken, rawNonce);

      // Fetch Firestore profile and build user state immediately,
      // rather than waiting for onAuthStateChanged (which races).
      const firestoreData = await fetchUserProfile(firebaseUser.uid).catch(
        () => null,
      );
      await tryQueueAccountMerge(firebaseUser, firestoreData, "apple");
      const user = buildUser(firebaseUser, firestoreData);
      const profileComplete = user.profileComplete === true;

      set({
        firebaseUser,
        user,
        isAuthenticated: true,
        profileComplete,
        hasAcceptedCurrentLegal:
          user.legalAcceptanceVersion === CURRENT_LEGAL_VERSION,
        isNewUser: !profileComplete,
        isLoading: false,
      });

      hydrateWallet(firebaseUser.uid);
      recoverSession(firebaseUser.uid);
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  sendEmailLink: async (email: string) => {
    set({ isLoading: true });

    try {
      await sendMagicLink(email);
      await SecureStore.setItemAsync(MAGIC_LINK_EMAIL_KEY, email);
      set({ isLoading: false });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  completeEmailLink: async (url: string) => {
    if (!(await isEmailSignInLink(url))) {
      throw new Error("Invalid email sign-in link");
    }

    set({ isLoading: true });

    try {
      const email = await SecureStore.getItemAsync(MAGIC_LINK_EMAIL_KEY);
      if (!email) {
        throw new Error("Email not found. Please try signing in again.");
      }

      const firebaseUser = await signInWithEmailLink(email, url);
      await SecureStore.deleteItemAsync(MAGIC_LINK_EMAIL_KEY);

      // Fetch Firestore profile and build user state immediately,
      // rather than waiting for onAuthStateChanged (which races).
      const firestoreData = await fetchUserProfile(firebaseUser.uid).catch(
        () => null,
      );
      await tryQueueAccountMerge(firebaseUser, firestoreData, "email");
      const user = buildUser(firebaseUser, firestoreData);
      const profileComplete = user.profileComplete === true;

      set({
        firebaseUser,
        user,
        isAuthenticated: true,
        profileComplete,
        hasAcceptedCurrentLegal:
          user.legalAcceptanceVersion === CURRENT_LEGAL_VERSION,
        isNewUser: !profileComplete,
        isLoading: false,
      });

      hydrateWallet(firebaseUser.uid);
      recoverSession(firebaseUser.uid);
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  phoneConfirmation: null,

  sendPhoneCode: async (phoneNumber: string) => {
    // Flip isLoading synchronously so any UI waiting on the flag (and the
    // unit test that observes it on the same tick) sees the in-flight state.
    set({ isLoading: true });

    const decision = await checkOtpThrottle(phoneNumber);
    if (!decision.allowed) {
      set({ isLoading: false });
      const wait = formatRetryAfter(decision.retryAfterMs ?? 60_000);
      const message =
        decision.reason === "hard_lockout"
          ? `Too many code requests. Try again in ${wait}.`
          : decision.reason === "window_exhausted"
            ? `You've hit the hourly limit. Try again in ${wait}.`
            : `Wait ${wait} before requesting another code.`;
      const err = new Error(message) as Error & {
        code?: string;
        retryAfterMs?: number;
      };
      err.code = "niyah/otp-throttled";
      err.retryAfterMs = decision.retryAfterMs;
      throw err;
    }

    try {
      const confirmation = await sendPhoneVerification(phoneNumber);
      await recordOtpSent(phoneNumber);
      set({ phoneConfirmation: confirmation, isLoading: false });
    } catch (error) {
      set({ isLoading: false });
      const code = (error as { code?: string }).code;
      if (code === "auth/too-many-requests") {
        await recordHardLockout(phoneNumber);
      }
      throw error;
    }
  },

  verifyPhoneCode: async (code: string) => {
    const { phoneConfirmation } = get();
    if (!phoneConfirmation) {
      throw new Error("No pending phone verification. Send a code first.");
    }

    set({ isLoading: true });
    try {
      const firebaseUser = await confirmPhoneCode(phoneConfirmation, code);

      // Verified — release the OTP throttle so a future re-auth starts clean.
      if (firebaseUser.phoneNumber) {
        clearOtpThrottle(firebaseUser.phoneNumber).catch(() => {});
      }

      // Fetch Firestore profile and build user state immediately
      const firestoreData = await fetchUserProfile(firebaseUser.uid).catch(
        () => null,
      );
      await tryQueueAccountMerge(firebaseUser, firestoreData, "phone");
      const user = buildUser(firebaseUser, firestoreData);
      const profileComplete = user.profileComplete === true;

      set({
        firebaseUser,
        user,
        isAuthenticated: true,
        profileComplete,
        hasAcceptedCurrentLegal:
          user.legalAcceptanceVersion === CURRENT_LEGAL_VERSION,
        isNewUser: !profileComplete,
        isLoading: false,
        phoneConfirmation: null,
      });

      hydrateWallet(firebaseUser.uid);
      recoverSession(firebaseUser.uid);
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  completeProfile: async (data) => {
    const { firebaseUser } = get();
    if (!firebaseUser) throw new Error("Not authenticated");

    set({ isLoading: true });

    try {
      const providerId = firebaseUser.providerId;
      let authProvider: "google" | "apple" | "email" | "phone" = "email";
      if (providerId === "google.com") authProvider = "google";
      else if (providerId === "apple.com") authProvider = "apple";
      else if (providerId === "phone") authProvider = "phone";

      await saveUserProfile(firebaseUser.uid, {
        firstName: data.firstName,
        lastName: data.lastName,
        email: firebaseUser.email || "",
        phone: data.phone,
        profileImage: firebaseUser.photoURL || undefined,
        blobAvatar: generateBlobAvatarPreset(firebaseUser.uid),
        authProvider,
      });

      const firestoreData = await fetchUserProfile(firebaseUser.uid);
      const user = buildUser(firebaseUser, firestoreData);

      set({
        user,
        profileComplete: true,
        isNewUser: false,
        isLoading: false,
      });

      logEvent("profile_complete", { authProvider });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  logout: async () => {
    set({ isSigningOut: true });

    // Clean up FCM token BEFORE signing out (needs valid auth session)
    const uid = get().user?.id;
    if (uid) {
      await cleanupNotifications(uid).catch((err) =>
        logger.error("Failed to clean up FCM token:", err),
      );
    }

    // Tear down Firestore listeners BEFORE signOut — after signOut the auth
    // token is revoked and any still-active listener will receive PERMISSION_DENIED.
    try {
      const { useGroupSessionStore } = require("./groupSessionStore") as {
        useGroupSessionStore: {
          getState: () => { unsubscribeAll: () => void };
        };
      };
      useGroupSessionStore.getState().unsubscribeAll();
    } catch {
      // Store may not be initialized
    }

    // Clear all user-scoped stores before signing out
    const { resetAllUserStores } = require("./resetCoordinator") as {
      resetAllUserStores: () => void;
    };
    resetAllUserStores();

    try {
      await signOut();
    } catch (error) {
      logger.error("Logout error:", error);
    }

    // Clear local auth state after signOut
    set({
      user: null,
      firebaseUser: null,
      isAuthenticated: false,
      profileComplete: false,
      hasAcceptedCurrentLegal: false,
      isNewUser: false,
      isSigningOut: false,
    });
  },

  updateUser: (updates: Partial<User>) => {
    const { user } = get();
    if (user) {
      set({ user: { ...user, ...updates } });

      // Sync stat fields to Firestore (fire-and-forget).
      // Only syncs recognized stat/profile fields to avoid writing transient UI state.
      const statsFields = [
        "currentStreak",
        "longestStreak",
        "totalSessions",
        "completedSessions",
        "totalEarnings",
      ] as const;
      const statsUpdate: Record<string, number> = {};
      for (const key of statsFields) {
        if (key in updates && typeof updates[key] === "number") {
          statsUpdate[key] = updates[key];
        }
      }
      if (Object.keys(statsUpdate).length > 0) {
        updateUserDoc(user.id, { stats: statsUpdate }).catch((err) =>
          logger.error("Failed to sync stats to Firestore:", err),
        );
      }
    }
  },

  updateReputation: (updates: Partial<UserReputation>) => {
    const { user } = get();
    if (user) {
      const newReputation = {
        ...user.reputation,
        ...updates,
        lastUpdated: new Date(),
      };

      const totalPayments =
        newReputation.paymentsCompleted + newReputation.paymentsMissed;
      if (totalPayments > 0) {
        const successRate = newReputation.paymentsCompleted / totalPayments;
        newReputation.score = Math.round(50 + (successRate - 0.5) * 100);
        newReputation.score = Math.max(0, Math.min(100, newReputation.score));
      }

      // Referral boost: permanently additive on top of the payment-based score.
      // Re-applied every recalculation so the boost persists through payment events.
      const referralBoost =
        (newReputation.referralCount ?? 0) * REFERRAL_REPUTATION_BOOST;
      newReputation.score = Math.min(100, newReputation.score + referralBoost);

      newReputation.level = getReputationLevel(newReputation.score);
      set({ user: { ...user, reputation: newReputation } });

      // Sync reputation to Firestore (fire-and-forget)
      updateUserDoc(user.id, { reputation: newReputation }).catch((err) =>
        logger.error("Failed to sync reputation to Firestore:", err),
      );
    }
  },

  setVenmoHandle: (handle: string) => {
    const { user } = get();
    if (user) {
      set({ user: { ...user, venmoHandle: handle } });

      // Sync to Firestore (fire-and-forget)
      updateUserDoc(user.id, { venmoHandle: handle }).catch((err) =>
        logger.error("Failed to sync venmoHandle to Firestore:", err),
      );
    }
  },

  setZelleHandle: (handle: string) => {
    const { user } = get();
    if (user) {
      set({ user: { ...user, zelleHandle: handle } });

      // Sync to Firestore (fire-and-forget)
      updateUserDoc(user.id, { zelleHandle: handle }).catch((err) =>
        logger.error("Failed to sync zelleHandle to Firestore:", err),
      );
    }
  },

  setBlobAvatar: (blobAvatar: BlobAvatarConfig) => {
    const { user } = get();
    if (user) {
      set({ user: { ...user, blobAvatar } });

      updateUserDoc(user.id, { blobAvatar }).catch((err) =>
        logger.error("Failed to sync blobAvatar to Firestore:", err),
      );
    }
  },

  acceptLegal: async () => {
    const { user } = get();
    if (!user) throw new Error("Not authenticated");

    if (!DEMO_MODE) {
      const { acceptLegalTerms } = require("../config/functions") as {
        acceptLegalTerms: (version: string) => Promise<{ success: boolean }>;
      };

      try {
        await acceptLegalTerms(CURRENT_LEGAL_VERSION);
      } catch (error) {
        logger.warn("acceptLegalTerms Cloud Function failed:", error);
      }
    }

    // Always persist client-side too. Belt-and-suspenders: if the Cloud
    // Function succeeds this is a redundant merge write; if it fails this
    // is the only path that actually lands the field in Firestore.
    try {
      await updateUserDoc(user.id, {
        legalAcceptanceVersion: CURRENT_LEGAL_VERSION,
        legalAcceptedAt: new Date(),
      });
    } catch (error) {
      logger.error("Failed to persist legal acceptance to Firestore:", error);
    }

    set({
      user: {
        ...user,
        legalAcceptanceVersion: CURRENT_LEGAL_VERSION,
        legalAcceptedAt: new Date(),
      },
      hasAcceptedCurrentLegal: true,
    });
  },
}));
