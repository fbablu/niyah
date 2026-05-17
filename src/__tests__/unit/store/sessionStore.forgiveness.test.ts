/**
 * First-surrender forgiveness. When cloudForfeit reports refundedCents > 0
 * the store must credit the wallet locally, expose lastForgivenCents for the
 * Complete screen, and mark the auth user as already-forgiven.
 */

jest.mock("../../../constants/config", () => ({
  ...jest.requireActual("../../../constants/config"),
  DEMO_MODE: false,
  DAILY_STAKE_CAP_CENTS: Number.MAX_SAFE_INTEGER,
}));

jest.mock("../../../config/firebase", () => ({
  writeSession: jest.fn().mockResolvedValue(undefined),
  updateSession: jest.fn().mockResolvedValue(undefined),
  getActiveSession: jest.fn().mockResolvedValue(null),
  updateUserDoc: jest.fn().mockResolvedValue(undefined),
  getWalletDoc: jest.fn().mockResolvedValue(null),
  subscribeToWallet: jest.fn(() => () => {}),
}));

jest.mock("../../../config/screentime", () => ({
  isScreenTimeAvailable: false,
  startBlocking: jest.fn().mockResolvedValue(undefined),
  stopBlocking: jest.fn().mockResolvedValue(undefined),
  onSurrenderRequested: jest.fn(() => () => {}),
  onShieldViolation: jest.fn(() => () => {}),
  startLiveActivity: jest.fn().mockResolvedValue(false),
  updateLiveActivity: jest.fn().mockResolvedValue(false),
  endLiveActivity: jest.fn().mockResolvedValue(false),
}));

jest.mock("../../../config/functions", () => ({
  handleSessionComplete: jest.fn(),
  handleSessionForfeit: jest.fn(),
}));

jest.mock("../../../utils/analytics", () => ({
  logEvent: jest.fn(),
}));

import { useSessionStore } from "../../../store/sessionStore";
import { useWalletStore } from "../../../store/walletStore";
import { useAuthStore } from "../../../store/authStore";
import { CADENCES, INITIAL_BALANCE } from "../../../constants/config";
import { handleSessionForfeit } from "../../../config/functions";

const makeUser = (firstSurrenderForgiven = false) => ({
  id: "forgive-user",
  email: "u@test.com",
  name: "U",
  balance: INITIAL_BALANCE,
  currentStreak: 0,
  longestStreak: 0,
  totalSessions: 0,
  completedSessions: 0,
  totalEarnings: 0,
  createdAt: new Date(),
  reputation: {
    score: 50,
    level: "sapling" as const,
    paymentsCompleted: 0,
    paymentsMissed: 0,
    totalOwedPaid: 0,
    totalOwedMissed: 0,
    lastUpdated: new Date(),
    referralCount: 0,
  },
  firstSurrenderForgiven,
});

describe("sessionStore — first-surrender forgiveness", () => {
  beforeEach(() => {
    useSessionStore.setState({
      currentSession: null,
      sessionHistory: [],
      isBlocking: false,
      violationCount: 0,
      lastForgivenCents: null,
    });
    useWalletStore.setState({
      balance: INITIAL_BALANCE,
      transactions: [],
      pendingWithdrawal: 0,
    });
    useAuthStore.setState({
      user: makeUser(false),
      isAuthenticated: true,
      isLoading: false,
    } as never);
  });

  it("credits wallet and sets lastForgivenCents when server forgives", async () => {
    jest.mocked(handleSessionForfeit).mockResolvedValue({
      success: true,
      forgiven: true,
      refundedCents: 500,
    });

    useSessionStore.getState().startSession("hour");
    const stake = CADENCES.hour.stake;
    const afterStake = useWalletStore.getState().balance;
    expect(afterStake).toBe(INITIAL_BALANCE - stake);

    useSessionStore.getState().surrenderSession();
    // Flush both the cloudForfeit promise and its .then()
    await new Promise((resolve) => setImmediate(resolve));

    expect(useSessionStore.getState().lastForgivenCents).toBe(500);
    expect(useWalletStore.getState().balance).toBe(
      INITIAL_BALANCE - stake + 500,
    );
    expect(useAuthStore.getState().user?.firstSurrenderForgiven).toBe(true);
  });

  it("does not credit wallet when server reports forgiven=false", async () => {
    jest.mocked(handleSessionForfeit).mockResolvedValue({
      success: true,
      forgiven: false,
    });

    useSessionStore.getState().startSession("hour");
    const stake = CADENCES.hour.stake;
    useSessionStore.getState().surrenderSession();
    await new Promise((resolve) => setImmediate(resolve));

    expect(useSessionStore.getState().lastForgivenCents).toBeNull();
    expect(useWalletStore.getState().balance).toBe(INITIAL_BALANCE - stake);
  });

  it("tolerates server failure without mutating forgiveness state", async () => {
    jest
      .mocked(handleSessionForfeit)
      .mockRejectedValue(new Error("network down"));

    useSessionStore.getState().startSession("hour");
    useSessionStore.getState().surrenderSession();
    await new Promise((resolve) => setImmediate(resolve));

    expect(useSessionStore.getState().lastForgivenCents).toBeNull();
    expect(useAuthStore.getState().user?.firstSurrenderForgiven).toBe(false);
  });

  it("clears stale lastForgivenCents on next startSession", async () => {
    jest.mocked(handleSessionForfeit).mockResolvedValue({
      success: true,
      forgiven: true,
      refundedCents: 500,
    });
    useSessionStore.getState().startSession("hour");
    useSessionStore.getState().surrenderSession();
    await new Promise((resolve) => setImmediate(resolve));
    expect(useSessionStore.getState().lastForgivenCents).toBe(500);

    useSessionStore.getState().startSession("focus");
    expect(useSessionStore.getState().lastForgivenCents).toBeNull();
  });
});
