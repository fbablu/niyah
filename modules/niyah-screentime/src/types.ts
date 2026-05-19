// ---------------------------------------------------------------------------
// Screen Time module types
// ---------------------------------------------------------------------------

/**
 * Authorization status for FamilyControls.
 * - "notDetermined": User hasn't been prompted yet
 * - "approved": User granted Screen Time access
 * - "denied": User denied access
 */
export type AuthorizationStatus = "notDetermined" | "approved" | "denied";

/**
 * Represents the current blocking state of the Screen Time module.
 * - "idle": No session active, no apps blocked
 * - "blocking": Session active, selected apps are shielded
 */
export type BlockingState = "idle" | "blocking";

/**
 * An opaque token representing a user's app selection from FamilyActivityPicker.
 * This token is stored natively -- JS never sees the actual app identifiers
 * (Apple's privacy model). We just pass it by reference ID.
 */
export interface AppSelectionToken {
  /** Unique ID for this saved selection (stored on the native side) */
  id: string;
  /** Number of apps in the selection */
  appCount: number;
  /** Number of categories in the selection */
  categoryCount: number;
  /** Human-readable label (e.g. "5 apps, 2 categories") */
  label: string;
}

/**
 * Event fired when a user opens a shielded/blocked app during a session.
 * This is the key event that triggers money deduction in Niyah.
 */
export interface ShieldViolationEvent {
  /** Timestamp (ms since epoch) when the violation occurred */
  timestamp: number;
}

/**
 * Events emitted by the NiyahScreenTime native module.
 */
export type NiyahScreenTimeModuleEvents = {
  /** Fired when the user attempts to open a blocked app */
  onShieldViolation: (event: ShieldViolationEvent) => void;
  /** Fired when authorization status changes */
  onAuthorizationChange: (event: { status: AuthorizationStatus }) => void;
  /**
   * Fired when the user taps "Surrender Session" on the custom Niyah
   * shield screen (NiyahShieldAction extension).
   * The main app should call surrenderSession() in response.
   */
  onSurrenderRequested: (event: Record<string, never>) => void;
};

// ---------------------------------------------------------------------------
// DeviceActivityReport baseline (Lane B2)
// ---------------------------------------------------------------------------

/**
 * Per-app baseline row written by the NiyahDeviceActivityReport extension
 * to shared App Group UserDefaults. `appBundleHash` is the only stable
 * cross-process identifier — Apple's ApplicationToken is opaque, so the
 * extension hashes it for use as a join key.
 */
export interface BaselineApp {
  appBundleHash: string;
  displayName: string;
  categoryName: string;
  dailyAverageMinutes: number;
  weeklyTotalMinutes: number;
}

// ---------------------------------------------------------------------------
// Live Activity (Lane B7)
// ---------------------------------------------------------------------------

/**
 * Static attributes for a Live Activity — set once at session start, never
 * change for the activity's lifetime. Matches `NiyahActivityAttributes` Swift
 * struct in `modules/niyah-screentime/ios/NiyahActivityAttributes.swift`.
 */
export interface LiveActivityAttrs {
  sessionId: string;
  sessionType: "solo" | "group";
  /** Asset name for the user's blob avatar in the widget extension bundle. */
  blobAssetName: string;
}

/**
 * Dynamic content-state for the Live Activity. Updated on every Firestore
 * session-doc tick from the JS side.
 */
export interface LiveActivityState {
  /** Absolute end timestamp in seconds since epoch. */
  endsAt: number;
  /** Top-3 leaderboard rows. Empty for solo sessions. */
  leaderboard: LiveActivityLeaderboardEntry[];
  /** Optimistic local payout share for the current user in cents. */
  userPayoutCents: number;
}

export interface LiveActivityLeaderboardEntry {
  name: string;
  status: "active" | "surrendered" | "completed";
  violations: number;
}

/** Combined payload accepted by `startLiveActivity` — attrs + initial state. */
export type LiveActivityStartPayload = LiveActivityAttrs & LiveActivityState;
