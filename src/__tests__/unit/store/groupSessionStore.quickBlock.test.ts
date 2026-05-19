/**
 * Tests for quick-block changes to groupSessionStore:
 *   - customDurationMs parameter
 *   - zero-stake sessions
 *   - USE_SHORT_TIMERS duration logic
 */

jest.mock("../../../config/firebase", () => ({
  onAuthStateChanged: jest.fn(() => jest.fn()),
  subscribeToGroupSession: jest.fn(() => jest.fn()),
  subscribeToGroupInvites: jest.fn(() => jest.fn()),
  subscribeToActiveGroupSessions: jest.fn(() => jest.fn()),
  updateSession: jest.fn(() => Promise.resolve()),
  fetchUserProfile: jest.fn(),
  updateUserDoc: jest.fn(() => Promise.resolve()),
  signOut: jest.fn(() => Promise.resolve()),
}));

jest.mock("../../../config/functions", () => ({
  createGroupSession: jest.fn(),
  respondToGroupInvite: jest.fn(),
  markOnlineForSession: jest.fn(),
  startGroupSessionCF: jest.fn(),
  reportSessionStatus: jest.fn(),
  cancelGroupSession: jest.fn(),
}));

jest.mock("../../../config/notifications", () => ({
  initializeNotifications: jest.fn(() => Promise.resolve(() => {})),
  removeFCMToken: jest.fn(() => Promise.resolve()),
  resetNotifications: jest.fn(),
  scheduleSessionEndNotification: jest.fn(() => Promise.resolve()),
  cancelSessionEndNotification: jest.fn(() => Promise.resolve()),
}));

import { useGroupSessionStore } from "../../../store/groupSessionStore";
import { useWalletStore } from "../../../store/walletStore";
import { useAuthStore } from "../../../store/authStore";
import { UserReputation } from "../../../types";
import { INITIAL_BALANCE } from "../../../constants/config";

const makeReputation = (
  overrides: Partial<UserReputation> = {},
): UserReputation => ({
  score: 50,
  level: "sapling",
  paymentsCompleted: 0,
  paymentsMissed: 0,
  totalOwedPaid: 0,
  totalOwedMissed: 0,
  lastUpdated: new Date(),
  referralCount: 0,
  ...overrides,
});

const ME = {
  userId: "me",
  name: "Test User",
  venmoHandle: "@me",
  reputation: makeReputation(),
};

const resetStores = () => {
  useGroupSessionStore.setState({
    activeGroupSession: null,
    groupSessionHistory: [],
  });
  useWalletStore.setState({
    balance: INITIAL_BALANCE,
    transactions: [],
    pendingWithdrawal: 0,
  });
  useAuthStore.setState({
    user: {
      id: "me",
      email: "me@test.com",
      name: "Test User",
      balance: INITIAL_BALANCE,
      currentStreak: 0,
      longestStreak: 0,
      totalSessions: 0,
      completedSessions: 0,
      totalEarnings: 0,
      createdAt: new Date(),
      reputation: makeReputation(),
    },
    isAuthenticated: true,
    isLoading: false,
  } as any);
};

describe("groupSessionStore quick-block", () => {
  beforeEach(() => {
    resetStores();
  });

  describe("customDurationMs parameter", () => {
    it("uses custom duration when provided", () => {
      const customMs = 25 * 60 * 1000; // 25 minutes
      useGroupSessionStore
        .getState()
        .startGroupSession("daily", [ME], customMs);

      const session = useGroupSessionStore.getState().activeGroupSession;
      expect(session).not.toBeNull();

      const duration = session!.endsAt.getTime() - session!.startedAt.getTime();
      // Allow 100ms tolerance for execution time
      expect(Math.abs(duration - customMs)).toBeLessThan(100);
    });

    it("sets zero stake when customDurationMs is provided", () => {
      useGroupSessionStore
        .getState()
        .startGroupSession("daily", [ME], 60 * 60 * 1000);

      const session = useGroupSessionStore.getState().activeGroupSession;
      expect(session!.stakePerParticipant).toBe(0);
      expect(session!.poolTotal).toBe(0);
    });

    it("does not deduct wallet balance for zero-stake session", () => {
      const balanceBefore = useWalletStore.getState().balance;

      useGroupSessionStore
        .getState()
        .startGroupSession("daily", [ME], 2 * 60 * 60 * 1000);

      expect(useWalletStore.getState().balance).toBe(balanceBefore);
    });

    it("participants have zero stakeAmount", () => {
      useGroupSessionStore
        .getState()
        .startGroupSession("daily", [ME], 30 * 60 * 1000);

      const session = useGroupSessionStore.getState().activeGroupSession;
      expect(session!.participants[0].stakeAmount).toBe(0);
    });
  });

  describe("without customDurationMs (normal session)", () => {
    it("uses cadence config stake", () => {
      useGroupSessionStore.getState().startGroupSession("daily", [ME]);

      const session = useGroupSessionStore.getState().activeGroupSession;
      // In DEMO_MODE (test env), stake should come from CADENCES.daily.stake
      expect(session!.stakePerParticipant).toBeGreaterThan(0);
    });

    it("deducts stake from wallet", () => {
      const balanceBefore = useWalletStore.getState().balance;

      useGroupSessionStore.getState().startGroupSession("daily", [ME]);

      const session = useGroupSessionStore.getState().activeGroupSession;
      expect(useWalletStore.getState().balance).toBe(
        balanceBefore - session!.stakePerParticipant,
      );
    });
  });

  describe("error cases", () => {
    it("throws if session already active", () => {
      useGroupSessionStore.getState().startGroupSession("daily", [ME], 60000);

      expect(() =>
        useGroupSessionStore.getState().startGroupSession("daily", [ME], 60000),
      ).toThrow("A group session is already active");
    });

    it("quick-block session can be completed", () => {
      useGroupSessionStore.getState().startGroupSession("daily", [ME], 60000);

      const result = useGroupSessionStore
        .getState()
        .completeGroupSession([{ userId: "me", completed: true }]);

      expect(result).toBeDefined();
      expect(result!.status).toBe("completed");
      expect(useGroupSessionStore.getState().activeGroupSession).toBeNull();
    });

    it("quick-block session can be surrendered", () => {
      useGroupSessionStore.getState().startGroupSession("daily", [ME], 60000);

      const result = useGroupSessionStore
        .getState()
        .completeGroupSession([{ userId: "me", completed: false }]);

      expect(result).toBeDefined();
      expect(result!.status).toBe("surrendered");
    });
  });
});
