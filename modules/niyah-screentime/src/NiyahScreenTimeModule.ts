import { NativeModule, requireNativeModule } from "expo";
import type {
  NiyahScreenTimeModuleEvents,
  AuthorizationStatus,
  AppSelectionToken,
  BaselineApp,
} from "./types";

declare class NiyahScreenTimeModuleClass extends NativeModule<NiyahScreenTimeModuleEvents> {
  // ------------------------------------------------------------------
  // Authorization
  // ------------------------------------------------------------------

  /** Request FamilyControls authorization from the user. */
  requestAuthorization(): Promise<AuthorizationStatus>;

  /** Get the current authorization status without prompting. */
  getAuthorizationStatus(): AuthorizationStatus;

  // ------------------------------------------------------------------
  // App selection
  // ------------------------------------------------------------------

  /**
   * Present the native FamilyActivityPicker so the user can choose
   * which apps/categories to block during sessions.
   *
   * The actual app tokens stay on the native side (Apple privacy model).
   * Returns a summary of what was selected.
   */
  presentAppPicker(): Promise<AppSelectionToken>;

  /** Get the currently saved app selection (if any). */
  getSavedSelection(): AppSelectionToken | null;

  /** Clear the saved app selection. */
  clearSelection(): Promise<void>;

  // ------------------------------------------------------------------
  // Blocking (session lifecycle)
  // ------------------------------------------------------------------

  /**
   * Start blocking the selected apps.
   * Call this when a Niyah session begins.
   * Applies a ManagedSettings shield to all selected apps.
   */
  startBlocking(): Promise<void>;

  /**
   * Stop blocking. Call when session ends (complete or surrender).
   * Removes the ManagedSettings shield.
   */
  stopBlocking(): Promise<void>;

  /** Check if apps are currently being blocked. */
  isBlocking(): boolean;

  // ------------------------------------------------------------------
  // Scheduled blocking (DeviceActivitySchedule)
  // ------------------------------------------------------------------

  /**
   * Start monitoring a DeviceActivitySchedule. The DeviceActivityMonitor
   * extension will apply/remove shields at the scheduled times.
   */
  startScheduledBlocking(
    startHour: number,
    startMinute: number,
    endHour: number,
    endMinute: number,
    activityName: string,
  ): Promise<void>;

  /** Stop monitoring a specific scheduled activity. */
  stopScheduledBlocking(activityName: string): Promise<void>;

  /** Stop all scheduled monitoring. */
  stopAllScheduledBlocking(): Promise<void>;

  // ------------------------------------------------------------------
  // Session context
  // ------------------------------------------------------------------

  /** Write session context for the dynamic shield display. */
  setSessionContext(contextJson: string): Promise<void>;

  /** Clear session context when session ends. */
  clearSessionContext(): Promise<void>;

  // ------------------------------------------------------------------
  // Surrender check
  // ------------------------------------------------------------------

  /**
   * Check for a pending surrender flag from the shield extension.
   * Solves the cold-start race condition where the onSurrenderRequested
   * event fires before the JS listener is attached.
   * If found, clears the flag and emits onSurrenderRequested.
   */
  checkPendingSurrender(): boolean;

  // ------------------------------------------------------------------
  // DeviceActivityReport baseline (Lane B2)
  // ------------------------------------------------------------------

  /**
   * Return the per-app baseline snapshot the NiyahDeviceActivityReport
   * extension persisted. Empty array if the extension hasn't yet
   * aggregated data — typically requires ~24h after first authorization.
   */
  getScreenTimeBaseline(): BaselineApp[];

  // ------------------------------------------------------------------
  // Live Activity (Lane B7)
  // ------------------------------------------------------------------

  /**
   * Start a Live Activity for an in-progress focus session.
   * `payload` JSON includes attrs + initial state. Returns true if the
   * activity was started, false otherwise (Live Activities disabled,
   * iOS <16.1, or ActivityKit error).
   */
  startLiveActivity(payloadJson: string): Promise<boolean>;

  /**
   * Update the active Live Activity's content state.
   * `stateJson` is the stringified LiveActivityState. No-op if no activity
   * is currently running.
   */
  updateLiveActivity(stateJson: string): Promise<boolean>;

  /** End the active Live Activity. Call on session complete or surrender. */
  endLiveActivity(): Promise<boolean>;
}

export default requireNativeModule<NiyahScreenTimeModuleClass>(
  "NiyahScreenTime",
);
