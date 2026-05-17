import { Platform } from "react-native";
import {
  NiyahScreenTime,
  type AuthorizationStatus,
  type AppSelectionToken,
  type ShieldViolationEvent,
  type BaselineApp,
  type LiveActivityStartPayload,
  type LiveActivityState,
} from "../../modules/niyah-screentime";
import { LANE_B_ENABLED } from "../constants/config";

// ---------------------------------------------------------------------------
// Feature availability
// ---------------------------------------------------------------------------

// iOS 16+ physical device only.
export const isScreenTimeAvailable =
  Platform.OS === "ios" && parseInt(Platform.Version as string, 10) >= 16;

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export const requestScreenTimeAuth = async (): Promise<AuthorizationStatus> => {
  if (!isScreenTimeAvailable) return "denied";
  return NiyahScreenTime.requestAuthorization();
};

export const getScreenTimeAuthStatus = (): AuthorizationStatus => {
  if (!isScreenTimeAvailable) return "denied";
  return NiyahScreenTime.getAuthorizationStatus();
};

// ---------------------------------------------------------------------------
// App selection
// ---------------------------------------------------------------------------

export const presentAppPicker = async (): Promise<AppSelectionToken> => {
  if (!isScreenTimeAvailable) {
    throw new Error("Screen Time API is not available on this device");
  }
  return NiyahScreenTime.presentAppPicker();
};

export const getSavedAppSelection = (): AppSelectionToken | null => {
  if (!isScreenTimeAvailable) return null;
  return NiyahScreenTime.getSavedSelection();
};

export const clearAppSelection = async (): Promise<void> => {
  if (!isScreenTimeAvailable) return;
  return NiyahScreenTime.clearSelection();
};

// ---------------------------------------------------------------------------
// Session blocking
// ---------------------------------------------------------------------------

export const startBlocking = async (): Promise<void> => {
  if (!isScreenTimeAvailable) return;
  return NiyahScreenTime.startBlocking();
};

export const stopBlocking = async (): Promise<void> => {
  if (!isScreenTimeAvailable) return;
  return NiyahScreenTime.stopBlocking();
};

export const isBlocking = (): boolean => {
  if (!isScreenTimeAvailable) return false;
  return NiyahScreenTime.isBlocking();
};

// ---------------------------------------------------------------------------
// Scheduled blocking
// ---------------------------------------------------------------------------

export const startScheduledBlocking = async (
  startHour: number,
  startMinute: number,
  endHour: number,
  endMinute: number,
  activityName: string,
): Promise<void> => {
  if (!isScreenTimeAvailable) return;
  return NiyahScreenTime.startScheduledBlocking(
    startHour,
    startMinute,
    endHour,
    endMinute,
    activityName,
  );
};

export const stopScheduledBlocking = async (
  activityName: string,
): Promise<void> => {
  if (!isScreenTimeAvailable) return;
  return NiyahScreenTime.stopScheduledBlocking(activityName);
};

export const stopAllScheduledBlocking = async (): Promise<void> => {
  if (!isScreenTimeAvailable) return;
  return NiyahScreenTime.stopAllScheduledBlocking();
};

// ---------------------------------------------------------------------------
// Session context (for dynamic shield)
// ---------------------------------------------------------------------------

/**
 * Set session context so the shield extension can display dynamic messages
 * with participant names and stake amounts during group sessions.
 */
export const setSessionContext = async (context: {
  names: string[];
  stake: number;
  type: "solo" | "group";
}): Promise<void> => {
  if (!isScreenTimeAvailable) return;
  return NiyahScreenTime.setSessionContext(JSON.stringify(context));
};

/**
 * Clear session context (call when session ends).
 */
export const clearSessionContext = async (): Promise<void> => {
  if (!isScreenTimeAvailable) return;
  return NiyahScreenTime.clearSessionContext();
};

// ---------------------------------------------------------------------------
// Violation events
// ---------------------------------------------------------------------------

/**
 * Subscribe to shield violation events (user opened a blocked app).
 * Returns an unsubscribe function.
 *
 * Usage:
 *   const unsub = onShieldViolation((event) => {
 *     console.log("Violation at", event.timestamp);
 *     // Deduct money from wallet
 *   });
 *   // Later: unsub();
 */
export const onShieldViolation = (
  callback: (event: ShieldViolationEvent) => void,
): (() => void) => {
  if (!isScreenTimeAvailable) return () => {};

  const subscription = NiyahScreenTime.addListener(
    "onShieldViolation",
    callback,
  );
  return () => subscription.remove();
};

export const onAuthorizationChange = (
  callback: (status: AuthorizationStatus) => void,
): (() => void) => {
  if (!isScreenTimeAvailable) return () => {};

  const subscription = NiyahScreenTime.addListener(
    "onAuthorizationChange",
    (event) => callback(event.status),
  );
  return () => subscription.remove();
};

/**
 * Subscribe to surrender requests from the custom shield screen.
 * Fired when the user taps "Surrender Session" on the NiyahShieldAction
 * extension. The main app should call surrenderSession() in response.
 * Returns an unsubscribe function.
 */
export const onSurrenderRequested = (callback: () => void): (() => void) => {
  if (!isScreenTimeAvailable) return () => {};

  const subscription = NiyahScreenTime.addListener(
    "onSurrenderRequested",
    callback,
  );
  return () => subscription.remove();
};

/**
 * Check for a pending surrender flag from the shield extension.
 * Call on mount to catch surrenders that happened before the JS event
 * listener was attached (cold-start race condition). If a pending
 * surrender is found, clears the flag and emits onSurrenderRequested.
 */
export const checkPendingSurrender = (): boolean => {
  if (!isScreenTimeAvailable) return false;
  return NiyahScreenTime.checkPendingSurrender();
};

// ---------------------------------------------------------------------------
// DeviceActivityReport baseline (Lane B2)
// ---------------------------------------------------------------------------

/**
 * Return the user's per-app baseline (top-N by daily-average minutes).
 * The NiyahDeviceActivityReport extension populates this on its own
 * schedule (typically every few hours after first authorization).
 *
 * Returns an empty array when:
 *   - Screen Time isn't available (non-iOS, iOS <16, missing entitlement)
 *   - The extension hasn't yet aggregated data (first ~24h)
 *   - LANE_B_ENABLED is false (extension not registered in build)
 */
export const getScreenTimeBaseline = (): BaselineApp[] => {
  if (!isScreenTimeAvailable || !LANE_B_ENABLED) return [];
  try {
    return NiyahScreenTime.getScreenTimeBaseline();
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Live Activity (Lane B7)
// ---------------------------------------------------------------------------

/**
 * Start a Live Activity for the current session. No-op when Lane B is
 * disabled or Screen Time / ActivityKit isn't available.
 *
 * Pass the full payload (static attrs + initial dynamic state). The
 * widget reads `endsAt` and lets the system tick the timer locally — we
 * do NOT need to call updateLiveActivity every second.
 *
 * Call sites:
 *   - sessionStore.startSession (solo)
 *   - groupSessionStore.startSession (group)
 */
export const startLiveActivity = async (
  payload: LiveActivityStartPayload,
): Promise<boolean> => {
  if (!isScreenTimeAvailable || !LANE_B_ENABLED) return false;
  return NiyahScreenTime.startLiveActivity(JSON.stringify(payload));
};

/**
 * Push a new dynamic state to the active Live Activity. Used when the
 * leaderboard composition or payout share shifts meaningfully — not on
 * every tick.
 */
export const updateLiveActivity = async (
  state: LiveActivityState,
): Promise<boolean> => {
  if (!isScreenTimeAvailable || !LANE_B_ENABLED) return false;
  return NiyahScreenTime.updateLiveActivity(JSON.stringify(state));
};

/** End the active Live Activity. Call on complete or surrender. */
export const endLiveActivity = async (): Promise<boolean> => {
  if (!isScreenTimeAvailable || !LANE_B_ENABLED) return false;
  return NiyahScreenTime.endLiveActivity();
};
