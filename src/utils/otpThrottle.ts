import * as SecureStore from "expo-secure-store";
import { logger } from "./logger";

/**
 * Client-side phone OTP throttle.
 *
 * NOT A SECURITY CONTROL. This is a UX guard that keeps a well-behaved user
 * from spamming Firebase's auth quota (which would then return opaque
 * `auth/too-many-requests` for ~15 minutes). State lives in SecureStore, so
 * a reinstall, OS reset, or rooted device trivially clears it. Abuse
 * prevention for phone auth is the responsibility of Firebase's
 * server-side rate limits + App Check attestation — both of which run
 * regardless of what this file does.
 *
 * Rules implemented: max 5 OTPs per phone per 60-minute window, with
 * exponential backoff after the 3rd send (30s → 2m → 5m), plus a hard
 * 15-min lockout if Firebase returns `auth/too-many-requests`.
 */

const WINDOW_MS = 60 * 60 * 1000; // 60 min
const MAX_SENDS_PER_WINDOW = 5;
const HARD_LOCKOUT_MS = 15 * 60 * 1000; // matches Firebase's typical lockout

const BACKOFF_BY_SEND: Record<number, number> = {
  3: 30 * 1000,
  4: 2 * 60 * 1000,
  5: 5 * 60 * 1000,
};

interface ThrottleRecord {
  windowStart: number;
  sendCount: number;
  lastSentAt: number;
  // Set when Firebase has rejected with auth/too-many-requests; resets at this ts.
  hardCooldownUntil?: number;
}

const keyFor = (phone: string): string =>
  `@niyah/otp_throttle:${phone.replace(/[^+0-9]/g, "")}`;

async function read(phone: string): Promise<ThrottleRecord | null> {
  try {
    const raw = await SecureStore.getItemAsync(keyFor(phone));
    if (!raw) return null;
    return JSON.parse(raw) as ThrottleRecord;
  } catch (err) {
    logger.warn("otpThrottle.read failed:", err);
    return null;
  }
}

async function write(phone: string, record: ThrottleRecord): Promise<void> {
  try {
    await SecureStore.setItemAsync(keyFor(phone), JSON.stringify(record));
  } catch (err) {
    logger.warn("otpThrottle.write failed:", err);
  }
}

async function clear(phone: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(keyFor(phone));
  } catch (err) {
    logger.warn("otpThrottle.clear failed:", err);
  }
}

export interface SendDecision {
  allowed: boolean;
  // If !allowed, milliseconds until the next send is permitted. >0.
  retryAfterMs?: number;
  // If !allowed, reason code for telemetry / UI copy.
  reason?: "hard_lockout" | "window_exhausted" | "backoff";
  // Send count consumed so far in the active window (for UI hints).
  sendsInWindow?: number;
}

const now = (): number => Date.now();

/** Inspect current throttle state without mutating it. */
export async function checkOtpThrottle(phone: string): Promise<SendDecision> {
  const record = await read(phone);
  if (!record) return { allowed: true, sendsInWindow: 0 };

  const t = now();
  if (record.hardCooldownUntil && record.hardCooldownUntil > t) {
    return {
      allowed: false,
      retryAfterMs: record.hardCooldownUntil - t,
      reason: "hard_lockout",
      sendsInWindow: record.sendCount,
    };
  }

  if (t - record.windowStart > WINDOW_MS) {
    return { allowed: true, sendsInWindow: 0 };
  }

  if (record.sendCount >= MAX_SENDS_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterMs: WINDOW_MS - (t - record.windowStart),
      reason: "window_exhausted",
      sendsInWindow: record.sendCount,
    };
  }

  const backoff = BACKOFF_BY_SEND[record.sendCount] ?? 0;
  if (backoff > 0 && t - record.lastSentAt < backoff) {
    return {
      allowed: false,
      retryAfterMs: backoff - (t - record.lastSentAt),
      reason: "backoff",
      sendsInWindow: record.sendCount,
    };
  }

  return { allowed: true, sendsInWindow: record.sendCount };
}

/** Record a successful (or attempted) OTP send. Must be called before fetching the next code. */
export async function recordOtpSent(phone: string): Promise<void> {
  const record = await read(phone);
  const t = now();
  if (!record || t - record.windowStart > WINDOW_MS) {
    await write(phone, { windowStart: t, sendCount: 1, lastSentAt: t });
    return;
  }
  await write(phone, {
    ...record,
    sendCount: record.sendCount + 1,
    lastSentAt: t,
    // Don't reset hardCooldownUntil — only `clearOtpThrottle` does that.
  });
}

/** Apply a hard lockout when Firebase rejects with auth/too-many-requests. */
export async function recordHardLockout(phone: string): Promise<void> {
  const record = (await read(phone)) ?? {
    windowStart: now(),
    sendCount: MAX_SENDS_PER_WINDOW,
    lastSentAt: now(),
  };
  await write(phone, {
    ...record,
    hardCooldownUntil: now() + HARD_LOCKOUT_MS,
    sendCount: MAX_SENDS_PER_WINDOW,
  });
}

/** Reset on successful verification — next sign-in attempt should start fresh. */
export async function clearOtpThrottle(phone: string): Promise<void> {
  await clear(phone);
}

/** Human-friendly cooldown formatting for inline copy. */
export function formatRetryAfter(ms: number): string {
  if (ms <= 1000) return "a moment";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
}
