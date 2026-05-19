// Session configurations
//
// Phase 1 (App Store launch): GROUP SESSIONS ONLY
//   Peer-to-peer pool. Completers split surrenderers' stakes. Niyah takes no cut.
//   All money comes from participants — no Niyah treasury involvement.
//
// Phase 2 (future): SOLO SESSIONS
//   Niyah is the counterparty. Complete = earn SOLO_COMPLETION_MULTIPLIER × stake.
//   Surrender = lose stake (Niyah keeps it). Requires Niyah to fund payouts.

// Payout multiplier for solo sessions (Phase 2, not yet active in sessionStore).
// Stake $5, complete → earn $10. Niyah profits if >50% of users surrender.
export const SOLO_COMPLETION_MULTIPLIER = 2;
export const CADENCES = {
  // ── Short sessions (for testing + quick use) ──────────────────────────────
  test: {
    id: "test",
    name: "Test",
    duration: 60 * 1000, // 1 minute
    demoDuration: 10 * 1000, // 10 seconds for demo
    stake: 100, // $1.00 in cents
  },
  focus: {
    id: "focus",
    name: "Focus",
    duration: 25 * 60 * 1000, // 25 minutes (Pomodoro)
    demoDuration: 15 * 1000, // 15 seconds for demo
    stake: 200, // $2.00 in cents
  },
  hour: {
    id: "hour",
    name: "Hour",
    duration: 60 * 60 * 1000, // 1 hour
    demoDuration: 30 * 1000, // 30 seconds for demo
    stake: 500, // $5.00 in cents
  },
  // ── Long sessions (real commitments) ──────────────────────────────────────
  daily: {
    id: "daily",
    name: "Daily",
    duration: 24 * 60 * 60 * 1000, // 24 hours in ms
    demoDuration: 10 * 1000, // 10 seconds for demo
    stake: 500, // $5.00 in cents - each partner stakes this
  },
  weekly: {
    id: "weekly",
    name: "Weekly",
    duration: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    demoDuration: 60 * 1000, // 60 seconds for demo
    stake: 2500, // $25.00 in cents
  },
  monthly: {
    id: "monthly",
    name: "Monthly",
    duration: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
    demoDuration: 90 * 1000, // 90 seconds for demo
    stake: 10000, // $100.00 in cents
  },
} as const;

export const SHORT_CADENCES: readonly string[] = ["test", "focus", "hour"];
export const LONG_CADENCES: readonly string[] = ["daily", "weekly", "monthly"];

// Demo mode: driven by env var so production builds can't accidentally ship demo.
// Set EXPO_PUBLIC_DEMO_MODE=true in .env for development; omit or set false for production.
export const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO_MODE === "true";
// Short timers: use demo durations (10s/60s/90s) with real backend + payments.
// Set EXPO_PUBLIC_SHORT_TIMERS=true in .env for quick testing without demo mode.
export const USE_SHORT_TIMERS =
  DEMO_MODE || process.env.EXPO_PUBLIC_SHORT_TIMERS === "true";
export const INITIAL_BALANCE = 5000; // $50.00 in cents

// Per-user daily stake cap (in cents). Mirrored server-side in Cloud Functions
// (DAILY_STAKE_CAP_CENTS in functions/src/index.ts). Limits total money a user
// can have at risk across solo + group sessions within a UTC day. Defaults to
// $25/day for campus launch. Raise after 3 clean days of real-money operation.
export const DAILY_STAKE_CAP_CENTS = 2500;

// Reputation thresholds
export const REPUTATION_LEVELS = {
  seed: { min: 0, max: 20, label: "Seed", description: "New to Niyah" },
  sprout: { min: 21, max: 40, label: "Sprout", description: "Growing trust" },
  sapling: {
    min: 41,
    max: 60,
    label: "Sapling",
    description: "Reliable partner",
  },
  tree: { min: 61, max: 80, label: "Tree", description: "Trusted member" },
  oak: {
    min: 81,
    max: 100,
    label: "Oak",
    description: "Pillar of the community",
  },
} as const;

// Legal versioning
// Bump this when Terms or Privacy content changes to re-prompt all users.
export const CURRENT_LEGAL_VERSION = "1.0.0";

// Referral system
// Each accepted referral permanently boosts the new user's social credit score by this amount.
// e.g. a brand-new user (score 50) who joins via referral starts at 60.
export const REFERRAL_REPUTATION_BOOST = 10; // points added to score per referral (max 100)
export const PENDING_REFERRAL_KEY = "@niyah/pending_referral"; // AsyncStorage key

// Hide phone auth button. Set EXPO_PUBLIC_DISABLE_PHONE_AUTH=true to disable
// phone sign-in when APNs Auth Key isn't yet registered in Firebase Console
// (otherwise phone auth falls back to reCAPTCHA web flow, which is brittle).
export const PHONE_AUTH_DISABLED =
  process.env.EXPO_PUBLIC_DISABLE_PHONE_AUTH === "true";

// Lane B (DeviceActivityReport + LiveActivity) runtime feature flag.
//
// Extensions ALWAYS register at build time now (via @bacons/apple-targets in
// app.config.js). This flag only gates user-facing surfaces: the new
// screentime-priorities onboarding screen + Live Activity start calls in
// the session stores. Lets us soft-roll the feature even when the binary
// already ships with the targets compiled.
export const LANE_B_ENABLED = process.env.EXPO_PUBLIC_LANE_B_ENABLED === "true";
