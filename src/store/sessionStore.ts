import { create } from "zustand";
import { Session, CadenceType } from "../types";
import {
  CADENCES,
  DEMO_MODE,
  USE_SHORT_TIMERS,
  DAILY_STAKE_CAP_CENTS,
} from "../constants/config";
import { useAuthStore } from "./authStore";
import { useWalletStore } from "./walletStore";
import {
  handleSessionComplete as cloudComplete,
  handleSessionForfeit as cloudForfeit,
} from "../config/functions";
import {
  writeSession,
  updateSession,
  getActiveSession,
} from "../config/firebase";
import {
  startBlocking,
  stopBlocking,
  onSurrenderRequested,
  onShieldViolation,
  startLiveActivity,
  endLiveActivity,
} from "../config/screentime";
import {
  scheduleSessionEndNotification,
  cancelSessionEndNotification,
} from "../config/notifications";
import { generateId } from "../utils/id";
import { logger } from "../utils/logger";
import { logEvent } from "../utils/analytics";

// Module-level flag to prevent race between recoverActiveSession and startSession
let _isRecovering = false;
// Cleanup function for violation listener
let _unsubViolation: (() => void) | null = null;

interface SessionState {
  currentSession: Session | null;
  sessionHistory: Session[];
  isBlocking: boolean;
  violationCount: number;
  /**
   * Cents refunded from the server via first-surrender forgiveness on the
   * most recent surrender. Read by the Complete screen to show a badge.
   * Reset to null at the start of every new session.
   */
  lastForgivenCents: number | null;

  startSession: (cadence: CadenceType) => void;
  surrenderSession: () => void;
  completeSession: () => void;
  getTimeRemaining: () => number;
  /** Recover an active session from Firestore after app restart. */
  recoverActiveSession: (userId: string) => Promise<void>;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  currentSession: null,
  sessionHistory: [],
  isBlocking: false,
  violationCount: 0,
  lastForgivenCents: null,

  startSession: (cadence: CadenceType) => {
    const { currentSession, sessionHistory } = get();
    if (currentSession || _isRecovering) {
      throw new Error(
        "A session is already active. Complete or surrender it first.",
      );
    }

    const config = CADENCES[cadence];
    const duration = USE_SHORT_TIMERS ? config.demoDuration : config.duration;

    // Daily stake cap (mirrored in Cloud Functions). Sums stakes from solo
    // sessions started today in local history; group session stakes enforced
    // server-side by createGroupSession / respondToGroupInvite CFs.
    if (!DEMO_MODE) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const stakedToday = sessionHistory
        .filter((s) => s.startedAt.getTime() >= startOfDay.getTime())
        .reduce((sum, s) => sum + s.stakeAmount, 0);
      if (stakedToday + config.stake > DAILY_STAKE_CAP_CENTS) {
        const remaining = Math.max(0, DAILY_STAKE_CAP_CENTS - stakedToday);
        throw new Error(
          `Daily stake cap reached. Remaining today: $${(remaining / 100).toFixed(2)}. Cap resets at midnight.`,
        );
      }
    }

    const session: Session = {
      id: generateId(),
      cadence,
      stakeAmount: config.stake,
      potentialPayout: config.stake,
      startedAt: new Date(),
      endsAt: new Date(Date.now() + duration),
      status: "active",
    };

    useWalletStore.getState().deductStake(config.stake, session.id);

    // Clear stale forgiveness flag — only relevant to the most recent surrender.
    set({ currentSession: session, isBlocking: true, lastForgivenCents: null });

    // Start Screen Time blocking (fire-and-forget; no-op on simulator)
    startBlocking().catch((err) =>
      logger.warn("Screen Time startBlocking failed:", err),
    );

    // Start Live Activity (no-op when Lane B disabled or iOS <16.1). Solo
    // sessions ship an empty leaderboard — the widget shows just timer + blob.
    {
      const userColor =
        useAuthStore.getState().user?.blobAvatar?.colorPreset ?? "forest";
      startLiveActivity({
        sessionId: session.id,
        sessionType: "solo",
        blobAssetName: `blob_${userColor}`,
        endsAt: session.endsAt.getTime() / 1000,
        leaderboard: [],
        userPayoutCents: session.potentialPayout,
      }).catch((err) => logger.warn("startLiveActivity (solo) failed:", err));
    }

    // Local notification fires at session.endsAt even if app is backgrounded.
    // Cancelled on completeSession/surrenderSession so a manually-ended session
    // never leaves a stale push pending.
    scheduleSessionEndNotification(
      session.endsAt,
      "Tap to collect your stake.",
    ).catch((err) =>
      logger.warn("scheduleSessionEndNotification failed:", err),
    );

    // Listen for surrender requests from the custom shield screen.
    // If the user taps "Surrender Session" on the Niyah shield while a
    // blocked app is open, the ShieldActionExtension writes a flag to
    // shared UserDefaults and this subscription picks it up.
    const unsubSurrender = onSurrenderRequested(() => {
      unsubSurrender();
      get().surrenderSession();
    });

    // Track shield violations (user tried to open a blocked app)
    _unsubViolation?.();
    _unsubViolation = onShieldViolation(() => {
      const { currentSession } = get();
      if (!currentSession) return;
      const newCount = get().violationCount + 1;
      set({ violationCount: newCount });

      // Fire-and-forget Firestore update
      updateSession(currentSession.id, {
        status: "active",
        violationCount: newCount,
      }).catch((err) => logger.warn("Failed to update violation count:", err));
    });

    // Persist session to Firestore (fire-and-forget)
    const userId = useAuthStore.getState().user?.id;
    if (userId) {
      writeSession(session.id, {
        userId,
        cadence: session.cadence,
        stakeAmount: session.stakeAmount,
        potentialPayout: session.potentialPayout,
        startedAt: session.startedAt,
        endsAt: session.endsAt,
        status: "active",
      }).catch((err) =>
        logger.error("Failed to persist session to Firestore:", err),
      );
    }

    logEvent("solo_session_started", {
      cadence,
      stakeAmount: session.stakeAmount,
    });
  },

  surrenderSession: () => {
    const { currentSession, sessionHistory } = get();
    if (!currentSession) return;

    const completedAt = new Date();
    const completedSession: Session = {
      ...currentSession,
      status: "surrendered",
      completedAt,
      actualPayout: 0,
    };

    const authStore = useAuthStore.getState();
    authStore.updateUser({
      currentStreak: 0,
      totalSessions: (authStore.user?.totalSessions || 0) + 1,
    });
    useWalletStore
      .getState()
      .recordForfeit(currentSession.stakeAmount, currentSession.id);

    // Stop Screen Time blocking (fire-and-forget)
    stopBlocking().catch((err) =>
      logger.warn("Screen Time stopBlocking (surrender) failed:", err),
    );
    endLiveActivity().catch((err) =>
      logger.warn("endLiveActivity (surrender) failed:", err),
    );
    cancelSessionEndNotification().catch(() => {});

    // Clean up violation listener
    _unsubViolation?.();
    _unsubViolation = null;

    set({
      currentSession: null,
      isBlocking: false,
      violationCount: 0,
      sessionHistory: [completedSession, ...sessionHistory],
    });

    // Status update path differs by mode:
    //   - DEMO_MODE: client writes status=surrendered directly (no CF).
    //   - prod: cloudForfeit's transaction does the update server-side.
    //     Writing here would race the CF's read — it would see status=
    //     surrendered and reject with 400 "Session is not active".
    if (DEMO_MODE) {
      updateSession(currentSession.id, {
        status: "surrendered",
        completedAt,
      }).catch((err) =>
        logger.error("Failed to update session in Firestore:", err),
      );
    } else {
      cloudForfeit(currentSession.id, currentSession.stakeAmount)
        .then((result) => {
          if (!result?.forgiven) return;
          const refunded = result.refundedCents ?? 0;
          if (refunded <= 0) return;
          useWalletStore.getState().deposit(refunded);
          useAuthStore.getState().updateUser({ firstSurrenderForgiven: true });
          set({ lastForgivenCents: refunded });
        })
        .catch((err) => logger.error("cloudForfeit failed:", err));
    }

    logEvent("solo_session_surrendered", {
      cadence: currentSession.cadence,
      stakeAmount: currentSession.stakeAmount,
    });
  },

  completeSession: () => {
    const { currentSession, sessionHistory } = get();
    if (!currentSession) return;

    const payout = currentSession.potentialPayout;
    const completedAt = new Date();

    const completedSession: Session = {
      ...currentSession,
      status: "completed",
      completedAt,
      actualPayout: payout,
    };

    const authStore = useAuthStore.getState();
    const newStreak = (authStore.user?.currentStreak || 0) + 1;
    authStore.updateUser({
      currentStreak: newStreak,
      longestStreak: Math.max(newStreak, authStore.user?.longestStreak || 0),
      totalSessions: (authStore.user?.totalSessions || 0) + 1,
      completedSessions: (authStore.user?.completedSessions || 0) + 1,
      // Net profit: payout minus stake already deducted at session start
      totalEarnings:
        (authStore.user?.totalEarnings || 0) +
        (payout - currentSession.stakeAmount),
    });
    useWalletStore.getState().creditPayout(payout, currentSession.id);

    // Stop Screen Time blocking (fire-and-forget)
    stopBlocking().catch((err) =>
      logger.warn("Screen Time stopBlocking (complete) failed:", err),
    );
    endLiveActivity().catch((err) =>
      logger.warn("endLiveActivity (complete) failed:", err),
    );
    cancelSessionEndNotification().catch(() => {});

    // Clean up violation listener
    _unsubViolation?.();
    _unsubViolation = null;

    set({
      currentSession: null,
      isBlocking: false,
      violationCount: 0,
      sessionHistory: [completedSession, ...sessionHistory],
    });

    // Update session doc in Firestore (fire-and-forget).
    // actualPayout is written by Cloud Functions only — not sent from client.
    updateSession(currentSession.id, {
      status: "completed",
      completedAt,
    }).catch((err) =>
      logger.error("Failed to update session in Firestore:", err),
    );

    // Sync to server (non-blocking — local state is source of truth in DEMO_MODE)
    if (!DEMO_MODE) {
      cloudComplete(currentSession.id, currentSession.stakeAmount).catch(
        (err) => logger.error("cloudComplete failed:", err),
      );
    }

    logEvent("solo_session_completed", {
      cadence: currentSession.cadence,
      stakeAmount: currentSession.stakeAmount,
      payoutAmount: payout,
    });
  },

  getTimeRemaining: () => {
    const { currentSession } = get();
    if (!currentSession) return 0;

    const remaining = currentSession.endsAt.getTime() - Date.now();
    return Math.max(0, remaining);
  },

  recoverActiveSession: async (userId: string) => {
    const { currentSession } = get();
    // Don't recover if we already have an active session in memory
    if (currentSession || _isRecovering) return;

    _isRecovering = true;
    try {
      const activeSession = await getActiveSession(userId);
      if (!activeSession) return;

      // Check if the session has already expired
      if (activeSession.endsAt.getTime() <= Date.now()) {
        // Session expired while app was closed — auto-complete it
        const payout = activeSession.potentialPayout;
        const completedAt = new Date();

        const completedSession: Session = {
          id: activeSession.id,
          cadence: activeSession.cadence as CadenceType,
          stakeAmount: activeSession.stakeAmount,
          potentialPayout: activeSession.potentialPayout,
          startedAt: activeSession.startedAt,
          endsAt: activeSession.endsAt,
          status: "completed",
          completedAt,
          actualPayout: payout,
        };

        // Mark the session as completed in Firestore FIRST. If this fails
        // (e.g. network timeout), we skip the local payout so the next app
        // restart will find the same "active" session and retry — preventing
        // duplicate local credits.
        try {
          await updateSession(activeSession.id, {
            status: "completed",
            completedAt,
          });
        } catch (err) {
          logger.error("Failed to auto-complete expired session:", err);
          // Firestore still has status: "active", so the next restart will
          // retry. Don't credit the payout locally to avoid double-counting.
          return;
        }

        const authStore = useAuthStore.getState();
        const newStreak = (authStore.user?.currentStreak || 0) + 1;
        authStore.updateUser({
          currentStreak: newStreak,
          longestStreak: Math.max(
            newStreak,
            authStore.user?.longestStreak || 0,
          ),
          totalSessions: (authStore.user?.totalSessions || 0) + 1,
          completedSessions: (authStore.user?.completedSessions || 0) + 1,
          totalEarnings:
            (authStore.user?.totalEarnings || 0) +
            (payout - activeSession.stakeAmount),
        });
        useWalletStore.getState().creditPayout(payout, activeSession.id);

        set((state) => ({
          sessionHistory: [completedSession, ...state.sessionHistory],
        }));

        // Clear any shields that lingered because the DeviceActivityMonitor
        // schedule isn't wired to the session duration yet — without these
        // calls the user reopens Niyah to find apps still blocked.
        stopBlocking().catch((err) =>
          logger.warn("stopBlocking (recovery) failed:", err),
        );
        endLiveActivity().catch(() => {});
        cancelSessionEndNotification().catch(() => {});

        if (!DEMO_MODE) {
          cloudComplete(activeSession.id, activeSession.stakeAmount).catch(
            (err) => logger.error("cloudComplete (recovery) failed:", err),
          );
        }
        return;
      }

      // Session is still active — restore it
      const restoredSession: Session = {
        id: activeSession.id,
        cadence: activeSession.cadence as CadenceType,
        stakeAmount: activeSession.stakeAmount,
        potentialPayout: activeSession.potentialPayout,
        startedAt: activeSession.startedAt,
        endsAt: activeSession.endsAt,
        status: "active",
      };

      set({ currentSession: restoredSession, isBlocking: true });
    } catch (error) {
      logger.error("Failed to recover active session:", error);
    } finally {
      _isRecovering = false;
    }
  },

  reset: () => {
    _unsubViolation?.();
    _unsubViolation = null;
    set({
      currentSession: null,
      sessionHistory: [],
      isBlocking: false,
      violationCount: 0,
      lastForgivenCents: null,
    });
  },
}));
