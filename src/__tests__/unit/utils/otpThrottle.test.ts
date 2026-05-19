/**
 * OTP throttle — behavioural tests for the client-side cooldown state machine.
 *
 * Important framing: this throttle is NOT a security control (see the module
 * header). These tests pin the UX contract:
 *
 *   - first 2 sends are immediate
 *   - sends 3/4/5 have escalating backoff (30s / 2m / 5m)
 *   - the 6th send inside a 60-min window is hard-blocked
 *   - `auth/too-many-requests` from Firebase escalates to a 15-min hard lockout
 *   - `clearOtpThrottle` resets state on successful verification
 *
 * Time is controlled with Jest's modern fake timers so each test is
 * deterministic without sleeping. SecureStore is mocked globally in
 * jest.setup.ts; we replace it here with an in-memory implementation so
 * record-then-read works across calls inside a single test.
 */

import * as SecureStore from "expo-secure-store";

const getItemMock = SecureStore.getItemAsync as jest.MockedFunction<
  typeof SecureStore.getItemAsync
>;
const setItemMock = SecureStore.setItemAsync as jest.MockedFunction<
  typeof SecureStore.setItemAsync
>;
const deleteItemMock = SecureStore.deleteItemAsync as jest.MockedFunction<
  typeof SecureStore.deleteItemAsync
>;

const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  getItemMock.mockReset();
  setItemMock.mockReset();
  deleteItemMock.mockReset();

  getItemMock.mockImplementation(async (k: string) =>
    memory.has(k) ? memory.get(k)! : null,
  );
  setItemMock.mockImplementation(async (k: string, v: string) => {
    memory.set(k, v);
  });
  deleteItemMock.mockImplementation(async (k: string) => {
    memory.delete(k);
  });

  jest.useFakeTimers({ doNotFake: ["setImmediate", "queueMicrotask"] });
  jest.setSystemTime(new Date("2026-05-14T00:00:00Z"));
});

afterEach(() => {
  jest.useRealTimers();
});

import {
  checkOtpThrottle,
  recordOtpSent,
  recordHardLockout,
  clearOtpThrottle,
  formatRetryAfter,
} from "../../../utils/otpThrottle";

const PHONE = "+12025551234";

const advance = (ms: number): void => {
  jest.setSystemTime(new Date(Date.now() + ms));
};

describe("checkOtpThrottle", () => {
  it("allows the first send with no history", async () => {
    const decision = await checkOtpThrottle(PHONE);
    expect(decision.allowed).toBe(true);
    expect(decision.sendsInWindow).toBe(0);
  });

  it("allows sends 1 and 2 with no backoff", async () => {
    await recordOtpSent(PHONE);
    advance(100);
    expect((await checkOtpThrottle(PHONE)).allowed).toBe(true);

    await recordOtpSent(PHONE);
    advance(100);
    expect((await checkOtpThrottle(PHONE)).allowed).toBe(true);
  });

  it("blocks send 3 for ~30s after send 3 is consumed", async () => {
    await recordOtpSent(PHONE); // 1
    await recordOtpSent(PHONE); // 2
    await recordOtpSent(PHONE); // 3

    const blocked = await checkOtpThrottle(PHONE);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("backoff");
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(30_000);

    advance(30_001);
    expect((await checkOtpThrottle(PHONE)).allowed).toBe(true);
  });

  it("escalates backoff after send 4 to ~2 minutes", async () => {
    // Walk through sends 1→3 stepping past each prior backoff, then send 4
    // and immediately re-check — should be in the send-4 backoff window.
    await recordOtpSent(PHONE); // 1
    await recordOtpSent(PHONE); // 2
    await recordOtpSent(PHONE); // 3
    advance(30_001); // past send-3 backoff
    await recordOtpSent(PHONE); // 4 — backoff for the *next* send is 2 min

    const blocked = await checkOtpThrottle(PHONE);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("backoff");
    expect(blocked.retryAfterMs).toBeGreaterThan(60_000); // > 1 min
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(2 * 60 * 1000);
  });

  it("hard-blocks the 6th send inside the window", async () => {
    for (let i = 0; i < 5; i++) {
      await recordOtpSent(PHONE);
      advance(5 * 60 * 1000); // step past each backoff
    }
    const decision = await checkOtpThrottle(PHONE);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("window_exhausted");
    expect(decision.sendsInWindow).toBe(5);
  });

  it("resets counter when the 60-min window rolls over", async () => {
    await recordOtpSent(PHONE);
    await recordOtpSent(PHONE);
    advance(60 * 60 * 1000 + 1_000); // past the window
    const decision = await checkOtpThrottle(PHONE);
    expect(decision.allowed).toBe(true);
    expect(decision.sendsInWindow).toBe(0);
  });

  it("normalises differently-formatted phone numbers to the same record", async () => {
    await recordOtpSent("+1 (202) 555-1234");
    const decision = await checkOtpThrottle("+12025551234");
    // Both spellings hit the same SecureStore key.
    expect(decision.sendsInWindow).toBe(1);
  });
});

describe("recordHardLockout", () => {
  it("blocks all sends for 15 minutes after Firebase too-many-requests", async () => {
    await recordHardLockout(PHONE);
    const decision = await checkOtpThrottle(PHONE);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("hard_lockout");
    // Should be within (0, 15*60*1000] ms.
    expect(decision.retryAfterMs).toBeGreaterThan(0);
    expect(decision.retryAfterMs).toBeLessThanOrEqual(15 * 60 * 1000);

    // Lockout survives further send attempts inside the window.
    await recordOtpSent(PHONE);
    expect((await checkOtpThrottle(PHONE)).reason).toBe("hard_lockout");
  });

  it("lockout expires after the 15-minute timer", async () => {
    await recordHardLockout(PHONE);
    advance(15 * 60 * 1000 + 1_000);
    // After the lockout clears, sendCount was capped at 5 so the
    // window-exhausted state takes over until the window rolls.
    const decision = await checkOtpThrottle(PHONE);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("window_exhausted");
  });
});

describe("clearOtpThrottle", () => {
  it("resets state so the next send starts fresh", async () => {
    await recordOtpSent(PHONE);
    await recordOtpSent(PHONE);
    await recordOtpSent(PHONE);
    expect((await checkOtpThrottle(PHONE)).allowed).toBe(false);

    await clearOtpThrottle(PHONE);
    const decision = await checkOtpThrottle(PHONE);
    expect(decision.allowed).toBe(true);
    expect(decision.sendsInWindow).toBe(0);
  });
});

describe("formatRetryAfter", () => {
  it("renders seconds, minutes, and hours sensibly", () => {
    expect(formatRetryAfter(500)).toBe("a moment");
    expect(formatRetryAfter(2_500)).toBe("3s");
    expect(formatRetryAfter(45_000)).toBe("45s");
    expect(formatRetryAfter(90_000)).toBe("2 min");
    expect(formatRetryAfter(70 * 60 * 1000)).toBe("2h");
  });
});
