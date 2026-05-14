/**
 * FCM Push Notification setup for Niyah.
 *
 * Handles:
 * - Permission request
 * - FCM token management (register/refresh/remove)
 * - Foreground message handling
 * - Background message handling
 * - Deep link navigation from notifications
 */

import {
  getMessaging,
  requestPermission,
  AuthorizationStatus,
  getToken,
  getAPNSToken,
  onTokenRefresh as subscribeToTokenRefresh,
  onMessage as subscribeToMessages,
  setBackgroundMessageHandler,
  getInitialNotification,
  onNotificationOpenedApp,
} from "@react-native-firebase/messaging";
import { getAuth } from "@react-native-firebase/auth";
import {
  getFirestore,
  doc,
  setDoc,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
} from "@react-native-firebase/firestore";
import { Platform } from "react-native";
import { router, type RelativePathString } from "expo-router";
import notifee, { AndroidImportance, EventType } from "@notifee/react-native";
import { logger } from "../utils/logger";

const NOTIFEE_CHANNEL_ID = "niyah-default";
let notifeeChannelCreated = false;

async function ensureNotifeeChannel(): Promise<void> {
  if (notifeeChannelCreated || Platform.OS !== "android") return;
  await notifee.createChannel({
    id: NOTIFEE_CHANNEL_ID,
    name: "Niyah Notifications",
    importance: AndroidImportance.HIGH,
  });
  notifeeChannelCreated = true;
}

const db = getFirestore();

const getMessagingInstance = () => getMessaging();

function isMissingAPNSTokenError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("No APNS token specified before fetching FCM Token")
  );
}

async function getCurrentFCMToken(): Promise<string | null> {
  const messaging = getMessagingInstance();

  if (Platform.OS === "ios") {
    const apnsToken = await getAPNSToken(messaging);

    if (!apnsToken) {
      logger.info("APNS token not ready yet; waiting for FCM token refresh");
      return null;
    }
  }

  return getToken(messaging);
}

// ─── Permission ─────────────────────────────────────────────────────────────

export async function requestNotificationPermission(): Promise<boolean> {
  const authStatus = await requestPermission(getMessagingInstance());
  const enabled =
    authStatus === AuthorizationStatus.AUTHORIZED ||
    authStatus === AuthorizationStatus.PROVISIONAL;

  if (!enabled) {
    logger.warn("Notification permission not granted");
  }

  return enabled;
}

// ─── Token Management ───────────────────────────────────────────────────────

/** Register the current device's FCM token in the user's Firestore doc. */
export async function registerFCMToken(): Promise<void> {
  try {
    const user = getAuth().currentUser;
    if (!user) return;

    const token = await getCurrentFCMToken();
    if (!token) {
      logger.warn("FCM token unavailable — will retry on next foreground");
      return;
    }

    // Store token in user doc (array of tokens for multi-device support)
    await setDoc(
      doc(db, "users", user.uid),
      {
        fcmTokens: arrayUnion(token),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    logger.info("FCM token registered");
  } catch (error) {
    if (Platform.OS === "ios" && isMissingAPNSTokenError(error)) {
      logger.info("APNS token not ready yet; waiting for FCM token refresh");
      return;
    }

    logger.error("Failed to register FCM token:", error);
  }
}

/** Remove the current device's FCM token on logout. */
export async function removeFCMToken(uid: string): Promise<void> {
  try {
    const token = await getCurrentFCMToken();
    if (!token) return;

    await setDoc(
      doc(db, "users", uid),
      {
        fcmTokens: arrayRemove(token),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    logger.info("FCM token removed");
  } catch (error) {
    if (Platform.OS === "ios" && isMissingAPNSTokenError(error)) {
      logger.info("APNS token not ready yet; skipping FCM token removal");
      return;
    }

    logger.error("Failed to remove FCM token:", error);
  }
}

/** Listen for token refreshes and update Firestore. */
export function onTokenRefresh(): () => void {
  return subscribeToTokenRefresh(getMessagingInstance(), async (newToken) => {
    const user = getAuth().currentUser;
    if (!user) return;

    await setDoc(
      doc(db, "users", user.uid),
      {
        fcmTokens: arrayUnion(newToken),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    logger.info("FCM token refreshed");
  });
}

// ─── Message Handling ───────────────────────────────────────────────────────

/** Handle notification taps that opened the app from background/quit state. */
function handleNotificationNavigation(
  data: Record<string, string> | undefined,
): void {
  if (!data) return;

  const { type, sessionId } = data;

  switch (type) {
    case "group_invite":
      router.push("/session/invites" as RelativePathString);
      break;
    case "invite_response":
    case "session_ready":
      if (sessionId)
        router.push(
          `/session/waiting-room?sessionId=${sessionId}` as RelativePathString,
        );
      break;
    case "session_started":
      router.push("/session/active");
      break;
    case "session_complete":
      router.push("/session/complete");
      break;
    // In-session pushes — they're informational; keep the user on the
    // active screen instead of forcing a navigation. Tapping the banner
    // still routes there in case the app was backgrounded.
    case "member_app_opened":
    case "leaderboard_shift":
    case "session_progress_25":
    case "session_progress_50":
    case "session_progress_75":
    case "shield_violation":
      router.push("/session/active");
      break;
    // Two-step shield surrender (Lane B5): tapping the push opens the
    // active session with a query param so the confirm sheet renders.
    case "surrender_confirm_pending":
      router.push(
        "/session/active?confirmSurrender=true" as RelativePathString,
      );
      break;
    default:
      break;
  }
}

/** Set up foreground message handler — displays a system-style banner via notifee. */
export function setupForegroundHandler(): () => void {
  // Apple "critical alert" level requires a special entitlement reserved for
  // health/safety apps. timeSensitive bypasses Focus modes without that gate.
  const unsubMessages = subscribeToMessages(
    getMessagingInstance(),
    async (remoteMessage) => {
      const { notification, data } = remoteMessage;
      if (!notification) return;

      await ensureNotifeeChannel();
      const payload = (data ?? {}) as Record<string, string>;

      await notifee.displayNotification({
        title: notification.title || "Niyah",
        body: notification.body || "",
        data: payload,
        android: {
          channelId: NOTIFEE_CHANNEL_ID,
          pressAction: { id: "default" },
          smallIcon: "ic_notification",
        },
        ios: {
          sound: "default",
          interruptionLevel: "timeSensitive",
          categoryId: payload.type,
        },
      });
    },
  );

  const unsubTap = notifee.onForegroundEvent(({ type, detail }) => {
    if (type !== EventType.PRESS) return;
    const data = detail.notification?.data as
      | Record<string, string>
      | undefined;
    handleNotificationNavigation(data);
  });

  return () => {
    unsubMessages();
    unsubTap();
  };
}

/** Set up background message handler. Must be called at app entry point. */
export function setupBackgroundHandler(): void {
  setBackgroundMessageHandler(getMessagingInstance(), async (remoteMessage) => {
    logger.info("Background message received:", remoteMessage.messageId);
    // Background messages are handled by the system notification tray.
    // Navigation happens via onNotificationOpenedApp when user taps.
  });

  // Local notifications (e.g. the SURRENDER_CONFIRM push scheduled by
  // ShieldActionExtension) bypass FCM and arrive through notifee. Register
  // the background tap handler here at module load so taps from outside the
  // app deep-link correctly even on cold start.
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    if (type !== EventType.PRESS) return;
    const data = detail.notification?.data as
      | Record<string, string>
      | undefined;
    handleNotificationNavigation(data);
  });
}

/** Check if app was opened from a notification (cold start). */
export async function checkInitialNotification(): Promise<void> {
  const initialNotification = await getInitialNotification(
    getMessagingInstance(),
  );
  if (initialNotification) {
    handleNotificationNavigation(
      initialNotification.data as Record<string, string>,
    );
  }
}

/** Set up handler for notification taps when app is in background. */
export function setupNotificationOpenHandler(): () => void {
  return onNotificationOpenedApp(getMessagingInstance(), (remoteMessage) => {
    handleNotificationNavigation(remoteMessage.data as Record<string, string>);
  });
}

// ─── Initialize ─────────────────────────────────────────────────────────────

let initPromise: Promise<() => void> | null = null;
let activeCleanup: (() => void) | null = null;

/**
 * Initialize all notification handling. Safe to call repeatedly — subsequent
 * calls return the in-flight or already-resolved init. Prevents listener
 * stacking when multiple auth paths race to initialize.
 */
export async function initializeNotifications(): Promise<() => void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const hasPermission = await requestNotificationPermission();
    if (!hasPermission) return () => {};

    const unsubTokenRefresh = onTokenRefresh();
    await registerFCMToken();
    const unsubForeground = setupForegroundHandler();
    const unsubOpen = setupNotificationOpenHandler();

    await checkInitialNotification();

    activeCleanup = () => {
      unsubTokenRefresh();
      unsubForeground();
      unsubOpen();
    };
    return activeCleanup;
  })();

  return initPromise;
}

/** Tear down active listeners and clear the init guard so re-login re-inits. */
export function resetNotifications(): void {
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
  initPromise = null;
}
