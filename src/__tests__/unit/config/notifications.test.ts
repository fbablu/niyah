/**
 * Unit Tests for notifications.ts
 *
 * Tests FCM push notification setup: permission requests, token management,
 * message handlers, deep link navigation, and full initialization lifecycle.
 *
 * Firebase messaging is mocked globally in jest.setup.ts. Since clearMocks
 * resets implementations between tests, we re-configure the shared mock
 * instance in beforeEach so every call to getMessaging() returns it.
 */

import {
  getMessaging,
  AuthorizationStatus,
} from "@react-native-firebase/messaging";
import { getAuth } from "@react-native-firebase/auth";
import { setDoc } from "@react-native-firebase/firestore";
import { Platform } from "react-native";
import { router } from "expo-router";

import {
  requestNotificationPermission,
  registerFCMToken,
  removeFCMToken,
  onTokenRefresh,
  setupForegroundHandler,
  setupBackgroundHandler,
  checkInitialNotification,
  setupNotificationOpenHandler,
  initializeNotifications,
} from "../../../config/notifications";

// Shared mock instance — getMessaging() always returns this same object.
const sharedInstance: Record<string, jest.Mock> = {
  requestPermission: jest.fn(() => Promise.resolve(1)),
  getToken: jest.fn(() => Promise.resolve("mock-fcm-token")),
  getAPNSToken: jest.fn(() => Promise.resolve("mock-apns-token")),
  registerDeviceForRemoteMessages: jest.fn(() => Promise.resolve()),
  onTokenRefresh: jest.fn(() => jest.fn()),
  onMessage: jest.fn(() => jest.fn()),
  onNotificationOpenedApp: jest.fn(() => jest.fn()),
  setBackgroundMessageHandler: jest.fn(),
  getInitialNotification: jest.fn(() => Promise.resolve(null)),
};

describe("notifications", () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    // Re-wire getMessaging() to return the shared instance with fresh mocks
    sharedInstance.requestPermission = jest.fn(() => Promise.resolve(1));
    sharedInstance.getToken = jest.fn(() => Promise.resolve("mock-fcm-token"));
    sharedInstance.getAPNSToken = jest.fn(() =>
      Promise.resolve("mock-apns-token"),
    );
    sharedInstance.registerDeviceForRemoteMessages = jest.fn(() =>
      Promise.resolve(),
    );
    sharedInstance.onTokenRefresh = jest.fn(() => jest.fn());
    sharedInstance.onMessage = jest.fn(() => jest.fn());
    sharedInstance.onNotificationOpenedApp = jest.fn(() => jest.fn());
    sharedInstance.setBackgroundMessageHandler = jest.fn();
    sharedInstance.getInitialNotification = jest.fn(() =>
      Promise.resolve(null),
    );

    (getMessaging as unknown as jest.Mock).mockReturnValue(sharedInstance);
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  // ─── requestNotificationPermission ──────────────────────────────────────────

  describe("requestNotificationPermission", () => {
    it("returns true when AUTHORIZED", async () => {
      sharedInstance.requestPermission.mockResolvedValue(
        AuthorizationStatus.AUTHORIZED,
      );

      const result = await requestNotificationPermission();
      expect(result).toBe(true);
    });

    it("returns true when PROVISIONAL", async () => {
      sharedInstance.requestPermission.mockResolvedValue(
        AuthorizationStatus.PROVISIONAL,
      );

      const result = await requestNotificationPermission();
      expect(result).toBe(true);
    });

    it("returns false when DENIED", async () => {
      const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
      sharedInstance.requestPermission.mockResolvedValue(
        AuthorizationStatus.DENIED,
      );

      const result = await requestNotificationPermission();
      expect(result).toBe(false);
      spy.mockRestore();
    });

    it("returns false when NOT_DETERMINED", async () => {
      const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
      sharedInstance.requestPermission.mockResolvedValue(
        AuthorizationStatus.NOT_DETERMINED,
      );

      const result = await requestNotificationPermission();
      expect(result).toBe(false);
      spy.mockRestore();
    });
  });

  // ─── registerFCMToken ───────────────────────────────────────────────────────

  describe("registerFCMToken", () => {
    it("no-ops when no user is signed in", async () => {
      (getAuth as jest.Mock).mockReturnValue({ currentUser: null });

      await registerFCMToken();

      expect(sharedInstance.getToken).not.toHaveBeenCalled();
      expect(setDoc).not.toHaveBeenCalled();
    });

    it("writes token on iOS", async () => {
      Platform.OS = "ios" as typeof Platform.OS;
      (getAuth as jest.Mock).mockReturnValue({
        currentUser: { uid: "user-123" },
      });
      sharedInstance.getAPNSToken.mockResolvedValue("ios-apns-token");
      sharedInstance.getToken.mockResolvedValue("ios-fcm-token");

      await registerFCMToken();

      expect(sharedInstance.getAPNSToken).toHaveBeenCalled();
      expect(sharedInstance.getToken).toHaveBeenCalled();
      expect(setDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          fcmTokens: expect.objectContaining({ __type: "arrayUnion" }),
        }),
        { merge: true },
      );
    });

    it("writes token without registerDevice on Android", async () => {
      Platform.OS = "android" as typeof Platform.OS;
      (getAuth as jest.Mock).mockReturnValue({
        currentUser: { uid: "user-456" },
      });
      sharedInstance.getToken.mockResolvedValue("android-fcm-token");

      await registerFCMToken();

      expect(sharedInstance.getAPNSToken).not.toHaveBeenCalled();
      expect(
        sharedInstance.registerDeviceForRemoteMessages,
      ).not.toHaveBeenCalled();
      expect(setDoc).toHaveBeenCalled();
    });

    it("no-ops on iOS when APNS token is unavailable", async () => {
      Platform.OS = "ios" as typeof Platform.OS;
      (getAuth as jest.Mock).mockReturnValue({
        currentUser: { uid: "user-apns" },
      });
      sharedInstance.getAPNSToken.mockResolvedValue(null as any);

      await registerFCMToken();

      expect(sharedInstance.getToken).not.toHaveBeenCalled();
      expect(setDoc).not.toHaveBeenCalled();
    });

    it("no-ops when getToken returns null", async () => {
      (getAuth as jest.Mock).mockReturnValue({
        currentUser: { uid: "user-789" },
      });
      sharedInstance.getToken.mockResolvedValue(null as any);

      await registerFCMToken();

      expect(setDoc).not.toHaveBeenCalled();
    });

    it("catches and swallows errors", async () => {
      (getAuth as jest.Mock).mockReturnValue({
        currentUser: { uid: "user-err" },
      });
      sharedInstance.getToken.mockRejectedValue(new Error("network error"));

      await expect(registerFCMToken()).resolves.toBeUndefined();
    });
  });

  // ─── removeFCMToken ─────────────────────────────────────────────────────────

  describe("removeFCMToken", () => {
    it("writes arrayRemove to user doc", async () => {
      sharedInstance.getToken.mockResolvedValue("device-token");

      await removeFCMToken("user-123");

      expect(setDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          fcmTokens: expect.objectContaining({
            __type: "arrayRemove",
            items: ["device-token"],
          }),
        }),
        { merge: true },
      );
    });

    it("no-ops when getToken returns null", async () => {
      sharedInstance.getToken.mockResolvedValue(null as any);

      await removeFCMToken("user-123");

      expect(setDoc).not.toHaveBeenCalled();
    });

    it("catches and swallows errors", async () => {
      sharedInstance.getToken.mockRejectedValue(new Error("fail"));

      await expect(removeFCMToken("user-123")).resolves.toBeUndefined();
    });
  });

  // ─── onTokenRefresh ─────────────────────────────────────────────────────────

  describe("onTokenRefresh", () => {
    it("registers a token refresh listener and returns unsubscribe", () => {
      const mockUnsub = jest.fn();
      sharedInstance.onTokenRefresh.mockReturnValue(mockUnsub);

      const unsub = onTokenRefresh();

      expect(sharedInstance.onTokenRefresh).toHaveBeenCalledWith(
        expect.any(Function),
      );
      expect(unsub).toBe(mockUnsub);
    });
  });

  // ─── setupForegroundHandler ─────────────────────────────────────────────────

  describe("setupForegroundHandler", () => {
    it("registers onMessage handler and returns combined cleanup", () => {
      const mockMessageUnsub = jest.fn();
      const mockTapUnsub = jest.fn();
      sharedInstance.onMessage.mockReturnValue(mockMessageUnsub);
      const notifee = jest.requireMock("@notifee/react-native").default as {
        onForegroundEvent: jest.Mock;
      };
      notifee.onForegroundEvent.mockReturnValueOnce(mockTapUnsub);

      const unsub = setupForegroundHandler();

      expect(sharedInstance.onMessage).toHaveBeenCalledWith(
        expect.any(Function),
      );
      expect(notifee.onForegroundEvent).toHaveBeenCalled();

      unsub();
      expect(mockMessageUnsub).toHaveBeenCalledTimes(1);
      expect(mockTapUnsub).toHaveBeenCalledTimes(1);
    });

    it("invokes notifee.displayNotification with timeSensitive iOS payload on incoming FCM message", async () => {
      let capturedHandler:
        | ((msg: {
            notification: { title: string; body: string };
            data: Record<string, string>;
          }) => Promise<void>)
        | undefined;
      sharedInstance.onMessage.mockImplementation((fn) => {
        capturedHandler = fn as typeof capturedHandler;
        return jest.fn();
      });
      const notifee = jest.requireMock("@notifee/react-native").default as {
        displayNotification: jest.Mock;
        onForegroundEvent: jest.Mock;
      };

      setupForegroundHandler();
      expect(capturedHandler).toBeDefined();
      await capturedHandler!({
        notification: { title: "Group invite", body: "Sarah invited you" },
        data: { type: "group_invite", sessionId: "abc123" },
      });

      expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
      const call = notifee.displayNotification.mock.calls[0][0];
      expect(call.title).toBe("Group invite");
      expect(call.body).toBe("Sarah invited you");
      expect(call.data).toEqual({
        type: "group_invite",
        sessionId: "abc123",
      });
      expect(call.ios.interruptionLevel).toBe("timeSensitive");
      expect(call.ios.sound).toBe("default");
      expect(call.ios.categoryId).toBe("group_invite");
    });

    it("routes tap events through handleNotificationNavigation with correct path", () => {
      let capturedTapHandler:
        | ((event: {
            type: number;
            detail: { notification: { data: Record<string, string> } };
          }) => void)
        | undefined;
      const notifee = jest.requireMock("@notifee/react-native").default as {
        onForegroundEvent: jest.Mock;
      };
      const { EventType } = jest.requireMock("@notifee/react-native") as {
        EventType: { PRESS: number };
      };
      notifee.onForegroundEvent.mockImplementation((fn) => {
        capturedTapHandler = fn;
        return jest.fn();
      });
      (router.push as jest.Mock).mockClear();

      setupForegroundHandler();
      capturedTapHandler!({
        type: EventType.PRESS,
        detail: {
          notification: {
            data: { type: "surrender_confirm_pending", sessionId: "s1" },
          },
        },
      });

      expect(router.push).toHaveBeenCalledWith(
        "/session/active?confirmSurrender=true",
      );
    });
  });

  // ─── setupBackgroundHandler ─────────────────────────────────────────────────

  describe("setupBackgroundHandler", () => {
    it("registers background message handler", () => {
      setupBackgroundHandler();

      expect(sharedInstance.setBackgroundMessageHandler).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });

    it("registers notifee background tap handler that routes surrender_confirm_pending", () => {
      const notifee = jest.requireMock("@notifee/react-native").default as {
        onBackgroundEvent: jest.Mock;
      };
      const { EventType } = jest.requireMock("@notifee/react-native") as {
        EventType: { PRESS: number };
      };
      let capturedHandler:
        | ((event: {
            type: number;
            detail: { notification: { data: Record<string, string> } };
          }) => Promise<void>)
        | undefined;
      notifee.onBackgroundEvent.mockImplementation((fn) => {
        capturedHandler = fn as typeof capturedHandler;
      });
      (router.push as jest.Mock).mockClear();

      setupBackgroundHandler();
      expect(capturedHandler).toBeDefined();

      capturedHandler!({
        type: EventType.PRESS,
        detail: {
          notification: { data: { type: "surrender_confirm_pending" } },
        },
      });
      expect(router.push).toHaveBeenCalledWith(
        "/session/active?confirmSurrender=true",
      );
    });
  });

  // ─── checkInitialNotification ───────────────────────────────────────────────

  describe("checkInitialNotification", () => {
    it("navigates when initial notification has data", async () => {
      sharedInstance.getInitialNotification.mockResolvedValue({
        data: { type: "group_invite" },
      });

      await checkInitialNotification();

      expect(router.push).toHaveBeenCalledWith("/session/invites");
    });

    it("no-ops when getInitialNotification returns null", async () => {
      sharedInstance.getInitialNotification.mockResolvedValue(null);

      await checkInitialNotification();

      expect(router.push).not.toHaveBeenCalled();
    });
  });

  // ─── setupNotificationOpenHandler ───────────────────────────────────────────

  describe("setupNotificationOpenHandler", () => {
    it("registers onNotificationOpenedApp and returns unsubscribe", () => {
      const mockUnsub = jest.fn();
      sharedInstance.onNotificationOpenedApp.mockReturnValue(mockUnsub);

      const unsub = setupNotificationOpenHandler();

      expect(sharedInstance.onNotificationOpenedApp).toHaveBeenCalledWith(
        expect.any(Function),
      );
      expect(unsub).toBe(mockUnsub);
    });
  });

  // ─── handleNotificationNavigation (via checkInitialNotification) ────────────

  describe("notification navigation", () => {
    it("navigates to /session/invites for group_invite", async () => {
      sharedInstance.getInitialNotification.mockResolvedValue({
        data: { type: "group_invite" },
      });

      await checkInitialNotification();

      expect(router.push).toHaveBeenCalledWith("/session/invites");
    });

    it("navigates to waiting-room for invite_response with sessionId", async () => {
      sharedInstance.getInitialNotification.mockResolvedValue({
        data: { type: "invite_response", sessionId: "sess-abc" },
      });

      await checkInitialNotification();

      expect(router.push).toHaveBeenCalledWith(
        "/session/waiting-room?sessionId=sess-abc",
      );
    });

    it("navigates to waiting-room for session_ready with sessionId", async () => {
      sharedInstance.getInitialNotification.mockResolvedValue({
        data: { type: "session_ready", sessionId: "sess-xyz" },
      });

      await checkInitialNotification();

      expect(router.push).toHaveBeenCalledWith(
        "/session/waiting-room?sessionId=sess-xyz",
      );
    });

    it("does not navigate for invite_response without sessionId", async () => {
      sharedInstance.getInitialNotification.mockResolvedValue({
        data: { type: "invite_response" },
      });

      await checkInitialNotification();

      expect(router.push).not.toHaveBeenCalled();
    });

    it("navigates to /session/active for session_started", async () => {
      sharedInstance.getInitialNotification.mockResolvedValue({
        data: { type: "session_started" },
      });

      await checkInitialNotification();

      expect(router.push).toHaveBeenCalledWith("/session/active");
    });

    it("navigates to /session/complete for session_complete", async () => {
      sharedInstance.getInitialNotification.mockResolvedValue({
        data: { type: "session_complete" },
      });

      await checkInitialNotification();

      expect(router.push).toHaveBeenCalledWith("/session/complete");
    });

    it("does not navigate for unknown type", async () => {
      sharedInstance.getInitialNotification.mockResolvedValue({
        data: { type: "unknown_type" },
      });

      await checkInitialNotification();

      expect(router.push).not.toHaveBeenCalled();
    });

    it("does not navigate when data is undefined", async () => {
      sharedInstance.getInitialNotification.mockResolvedValue({
        data: undefined,
      });

      await checkInitialNotification();

      expect(router.push).not.toHaveBeenCalled();
    });
  });

  // ─── initializeNotifications ────────────────────────────────────────────────

  describe("initializeNotifications", () => {
    it("returns cleanup function that calls all unsubs", async () => {
      sharedInstance.requestPermission.mockResolvedValue(
        AuthorizationStatus.AUTHORIZED,
      );
      (getAuth as jest.Mock).mockReturnValue({
        currentUser: { uid: "user-init" },
      });
      sharedInstance.getToken.mockResolvedValue("init-token");
      sharedInstance.getInitialNotification.mockResolvedValue(null);

      const mockUnsubRefresh = jest.fn();
      const mockUnsubForeground = jest.fn();
      const mockUnsubOpen = jest.fn();
      sharedInstance.onTokenRefresh.mockReturnValue(mockUnsubRefresh);
      sharedInstance.onMessage.mockReturnValue(mockUnsubForeground);
      sharedInstance.onNotificationOpenedApp.mockReturnValue(mockUnsubOpen);

      const cleanup = await initializeNotifications();

      expect(sharedInstance.requestPermission).toHaveBeenCalled();
      expect(sharedInstance.onTokenRefresh).toHaveBeenCalled();
      expect(sharedInstance.onMessage).toHaveBeenCalled();
      expect(sharedInstance.onNotificationOpenedApp).toHaveBeenCalled();
      expect(sharedInstance.getInitialNotification).toHaveBeenCalled();

      cleanup();

      expect(mockUnsubRefresh).toHaveBeenCalled();
      expect(mockUnsubForeground).toHaveBeenCalled();
      expect(mockUnsubOpen).toHaveBeenCalled();
    });

    it("returns noop when permission is denied", async () => {
      const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
      sharedInstance.requestPermission.mockResolvedValue(
        AuthorizationStatus.DENIED,
      );

      const cleanup = await initializeNotifications();

      expect(sharedInstance.onTokenRefresh).not.toHaveBeenCalled();
      expect(sharedInstance.onMessage).not.toHaveBeenCalled();
      expect(sharedInstance.onNotificationOpenedApp).not.toHaveBeenCalled();

      expect(() => cleanup()).not.toThrow();
      spy.mockRestore();
    });
  });
});
