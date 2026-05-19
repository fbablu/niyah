/**
 * sessionStore — Fire-and-Forget & Recovery Tests
 *
 * Covers async fire-and-forget paths that the main sessionStore.test.ts
 * does not exercise because it doesn't mock the config modules:
 *
 * - startBlocking / stopBlocking rejection paths
 * - onSurrenderRequested callback
 * - updateSession rejection in surrenderSession / completeSession
 * - recoverActiveSession (expired session auto-complete path)
 */

jest.mock("../../../config/firebase", () => ({
  writeSession: jest.fn(() => Promise.resolve()),
  updateSession: jest.fn(() => Promise.resolve()),
  getActiveSession: jest.fn(() => Promise.resolve(null)),
  // Auth-related — required by transitive authStore import
  onAuthStateChanged: jest.fn(() => jest.fn()),
  signOut: jest.fn(),
  signInWithGoogle: jest.fn(),
  signInWithApple: jest.fn(),
  sendMagicLink: jest.fn(),
  signInWithEmailLink: jest.fn(),
  isEmailSignInLink: jest.fn(),
  saveUserProfile: jest.fn(),
  fetchUserProfile: jest.fn(),
  awardReferralToUser: jest.fn(),
  updateUserDoc: jest.fn(() => Promise.resolve()),
  getWalletDoc: jest.fn(() => Promise.resolve(null)),
  subscribeToWallet: jest.fn(() => jest.fn()),
}));

jest.mock("../../../config/screentime", () => ({
  startBlocking: jest.fn(() => Promise.resolve()),
  stopBlocking: jest.fn(() => Promise.resolve()),
  onSurrenderRequested: jest.fn(() => jest.fn()),
  onShieldViolation: jest.fn(() => jest.fn()),
  startLiveActivity: jest.fn(() => Promise.resolve(false)),
  updateLiveActivity: jest.fn(() => Promise.resolve(false)),
  endLiveActivity: jest.fn(() => Promise.resolve(false)),
}));

jest.mock("../../../config/functions", () => ({
  handleSessionComplete: jest.fn(() =>
    Promise.resolve({ newBalance: 0, payout: 0 }),
  ),
  handleSessionForfeit: jest.fn(() => Promise.resolve({ success: true })),
}));

import { act } from "react";
import { useSessionStore } from "../../../store/sessionStore";
import { useWalletStore } from "../../../store/walletStore";
import { useAuthStore } from "../../../store/authStore";
import { CADENCES, INITIAL_BALANCE } from "../../../constants/config";
import {
  startBlocking,
  stopBlocking,
  onSurrenderRequested,
} from "../../../config/screentime";
import {
  writeSession,
  updateSession,
  getActiveSession,
} from "../../../config/firebase";

// Helper: flush microtasks so fire-and-forget promises settle
const flushPromises = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("sessionStore — fire-and-forget paths", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    useSessionStore.setState({
      currentSession: null,
      sessionHistory: [],
      isBlocking: false,
    });

    useWalletStore.setState({
      balance: INITIAL_BALANCE,
      transactions: [
        {
          id: "initial",
          type: "deposit",
          amount: INITIAL_BALANCE,
          description: "Welcome bonus",
          createdAt: new Date(),
        },
      ],
      pendingWithdrawal: 0,
    });

    useAuthStore.setState({
      user: {
        id: "test-user",
        email: "test@example.com",
        name: "Test User",
        balance: INITIAL_BALANCE,
        currentStreak: 0,
        longestStreak: 0,
        totalSessions: 0,
        completedSessions: 0,
        totalEarnings: 0,
        createdAt: new Date(),
        reputation: {
          score: 50,
          level: "sapling",
          paymentsCompleted: 0,
          paymentsMissed: 0,
          totalOwedPaid: 0,
          totalOwedMissed: 0,
          lastUpdated: new Date(),
          referralCount: 0,
        },
      },
      isAuthenticated: true,
      isLoading: false,
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ─── startBlocking error (line 69) ──────────────────────────────────────────

  it("session still starts when startBlocking rejects", async () => {
    jest
      .mocked(startBlocking)
      .mockRejectedValueOnce(new Error("ScreenTime unavailable"));

    act(() => {
      useSessionStore.getState().startSession("daily");
    });

    // Session should be active despite startBlocking failure
    expect(useSessionStore.getState().currentSession?.status).toBe("active");
    expect(useSessionStore.getState().isBlocking).toBe(true);

    // Let the rejected promise settle (covers the .catch handler on line 69)
    await flushPromises();
  });

  // ─── onSurrenderRequested callback (lines 77-78) ───────────────────────────

  it("triggers surrenderSession when onSurrenderRequested fires", async () => {
    // Capture the callback passed to onSurrenderRequested
    let capturedCallback: (() => void) | null = null;
    jest.mocked(onSurrenderRequested).mockImplementation((cb) => {
      capturedCallback = cb;
      return jest.fn(); // unsubscribe
    });

    act(() => {
      useSessionStore.getState().startSession("daily");
    });

    expect(capturedCallback).not.toBeNull();
    expect(useSessionStore.getState().currentSession).not.toBeNull();

    // Fire the surrender callback (simulating shield tap)
    act(() => {
      capturedCallback!();
    });

    // Session should now be surrendered
    expect(useSessionStore.getState().currentSession).toBeNull();
    expect(useSessionStore.getState().sessionHistory).toHaveLength(1);
    expect(useSessionStore.getState().sessionHistory[0].status).toBe(
      "surrendered",
    );
  });

  // ─── stopBlocking error in surrender (line 121) ────────────────────────────

  it("surrender completes when stopBlocking rejects", async () => {
    jest
      .mocked(stopBlocking)
      .mockRejectedValueOnce(new Error("ScreenTime error"));

    act(() => {
      useSessionStore.getState().startSession("daily");
    });

    act(() => {
      useSessionStore.getState().surrenderSession();
    });

    // Surrender should still complete
    expect(useSessionStore.getState().currentSession).toBeNull();
    expect(useSessionStore.getState().isBlocking).toBe(false);
    expect(useSessionStore.getState().sessionHistory[0].status).toBe(
      "surrendered",
    );

    await flushPromises();
  });

  // ─── updateSession error in surrender (line 136) ──────────────────────────

  it("surrender completes when updateSession rejects", async () => {
    jest
      .mocked(updateSession)
      .mockRejectedValueOnce(new Error("Firestore offline"));

    act(() => {
      useSessionStore.getState().startSession("daily");
    });

    act(() => {
      useSessionStore.getState().surrenderSession();
    });

    expect(useSessionStore.getState().currentSession).toBeNull();
    expect(useSessionStore.getState().sessionHistory[0].status).toBe(
      "surrendered",
    );

    await flushPromises();
  });

  // ─── stopBlocking error in completeSession (line 177) ─────────────────────

  it("completeSession succeeds when stopBlocking rejects", async () => {
    jest
      .mocked(stopBlocking)
      .mockRejectedValueOnce(new Error("ScreenTime error"));

    act(() => {
      useSessionStore.getState().startSession("daily");
    });

    act(() => {
      useSessionStore.getState().completeSession();
    });

    expect(useSessionStore.getState().currentSession).toBeNull();
    expect(useSessionStore.getState().isBlocking).toBe(false);
    expect(useSessionStore.getState().sessionHistory[0].status).toBe(
      "completed",
    );

    await flushPromises();
  });

  // ─── updateSession error in completeSession (line 192) ────────────────────

  it("completeSession succeeds when updateSession rejects", async () => {
    jest
      .mocked(updateSession)
      .mockRejectedValueOnce(new Error("Firestore offline"));

    act(() => {
      useSessionStore.getState().startSession("daily");
    });

    act(() => {
      useSessionStore.getState().completeSession();
    });

    expect(useSessionStore.getState().currentSession).toBeNull();
    expect(useSessionStore.getState().sessionHistory[0].status).toBe(
      "completed",
    );

    await flushPromises();
  });

  // ─── writeSession is called with correct data ─────────────────────────────

  it("calls writeSession with session data on startSession", async () => {
    act(() => {
      useSessionStore.getState().startSession("daily");
    });

    await flushPromises();

    expect(writeSession).toHaveBeenCalledTimes(1);
    const [sessionId, data] = jest.mocked(writeSession).mock.calls[0];
    expect(sessionId).toBeDefined();
    expect(data).toMatchObject({
      userId: "test-user",
      cadence: "daily",
      stakeAmount: CADENCES.daily.stake,
      status: "active",
    });
  });
});

describe("sessionStore — recoverActiveSession", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    useSessionStore.setState({
      currentSession: null,
      sessionHistory: [],
      isBlocking: false,
    });

    useWalletStore.setState({
      balance: INITIAL_BALANCE,
      transactions: [
        {
          id: "initial",
          type: "deposit",
          amount: INITIAL_BALANCE,
          description: "Welcome bonus",
          createdAt: new Date(),
        },
      ],
      pendingWithdrawal: 0,
    });

    useAuthStore.setState({
      user: {
        id: "test-user",
        email: "test@example.com",
        name: "Test User",
        balance: INITIAL_BALANCE,
        currentStreak: 2,
        longestStreak: 5,
        totalSessions: 10,
        completedSessions: 8,
        totalEarnings: 0,
        createdAt: new Date(),
        reputation: {
          score: 50,
          level: "sapling",
          paymentsCompleted: 0,
          paymentsMissed: 0,
          totalOwedPaid: 0,
          totalOwedMissed: 0,
          lastUpdated: new Date(),
          referralCount: 0,
        },
      },
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it("auto-completes an expired session (lines 263, 268)", async () => {
    const expiredSession = {
      id: "expired-session-1",
      cadence: "daily",
      stakeAmount: CADENCES.daily.stake,
      potentialPayout: CADENCES.daily.stake,
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
      endsAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // ended 1 hour ago
      status: "active",
    };

    jest.mocked(getActiveSession).mockResolvedValueOnce(expiredSession);

    await useSessionStore.getState().recoverActiveSession("test-user");

    // Session should be auto-completed and added to history
    const history = useSessionStore.getState().sessionHistory;
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("completed");
    expect(history[0].actualPayout).toBe(CADENCES.daily.stake);
    expect(history[0].completedAt).toBeDefined();

    // No active session should remain
    expect(useSessionStore.getState().currentSession).toBeNull();

    // User stats should be updated
    const user = useAuthStore.getState().user;
    expect(user?.currentStreak).toBe(3); // was 2, now 3
    expect(user?.totalSessions).toBe(11); // was 10
    expect(user?.completedSessions).toBe(9); // was 8

    // Wallet should be credited
    expect(useWalletStore.getState().balance).toBe(
      INITIAL_BALANCE + CADENCES.daily.stake,
    );

    // updateSession should have been called (line 263)
    expect(updateSession).toHaveBeenCalledWith(
      "expired-session-1",
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("auto-complete skips local credit when updateSession rejects (prevents double-credit)", async () => {
    jest
      .mocked(updateSession)
      .mockRejectedValueOnce(new Error("Firestore offline"));

    const expiredSession = {
      id: "expired-2",
      cadence: "daily",
      stakeAmount: CADENCES.daily.stake,
      potentialPayout: CADENCES.daily.stake,
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      status: "active",
    };

    jest.mocked(getActiveSession).mockResolvedValueOnce(expiredSession);

    const balanceBefore = useWalletStore.getState().balance;

    // Should not throw
    await useSessionStore.getState().recoverActiveSession("test-user");

    // Session should NOT be completed locally — Firestore still has status: "active",
    // so the next restart will safely retry the recovery.
    expect(useSessionStore.getState().sessionHistory).toHaveLength(0);
    expect(useSessionStore.getState().currentSession).toBeNull();

    // Wallet should NOT be credited (prevents double-credit on next restart)
    expect(useWalletStore.getState().balance).toBe(balanceBefore);

    await flushPromises();
  });

  it("restores a still-active session to state", async () => {
    const activeSession = {
      id: "active-session-1",
      cadence: "daily",
      stakeAmount: CADENCES.daily.stake,
      potentialPayout: CADENCES.daily.stake,
      startedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
      endsAt: new Date(Date.now() + 50 * 60 * 1000), // 50 min from now
      status: "active",
    };

    jest.mocked(getActiveSession).mockResolvedValueOnce(activeSession);

    await useSessionStore.getState().recoverActiveSession("test-user");

    const session = useSessionStore.getState().currentSession;
    expect(session).not.toBeNull();
    expect(session?.id).toBe("active-session-1");
    expect(session?.status).toBe("active");
    expect(useSessionStore.getState().isBlocking).toBe(true);
  });

  it("does nothing when no active session exists in Firestore", async () => {
    jest.mocked(getActiveSession).mockResolvedValueOnce(null);

    await useSessionStore.getState().recoverActiveSession("test-user");

    expect(useSessionStore.getState().currentSession).toBeNull();
    expect(useSessionStore.getState().sessionHistory).toHaveLength(0);
  });

  it("does nothing when a session is already in memory", async () => {
    // Start a session first
    act(() => {
      useSessionStore.getState().startSession("daily");
    });

    const existingSession = useSessionStore.getState().currentSession;

    await useSessionStore.getState().recoverActiveSession("test-user");

    // getActiveSession should not have been called
    expect(getActiveSession).not.toHaveBeenCalled();

    // Existing session should remain unchanged
    expect(useSessionStore.getState().currentSession?.id).toBe(
      existingSession?.id,
    );
  });

  it("handles getActiveSession failure gracefully", async () => {
    jest
      .mocked(getActiveSession)
      .mockRejectedValueOnce(new Error("Network error"));

    // Should not throw
    await useSessionStore.getState().recoverActiveSession("test-user");

    expect(useSessionStore.getState().currentSession).toBeNull();
  });
});
