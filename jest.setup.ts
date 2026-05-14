import * as React from "react";

// Define __DEV__ globally for expo modules that reference it
// @ts-expect-error __DEV__ is a React Native global
globalThis.__DEV__ = true;

// Suppress console.error during tests.
// Error-path tests intentionally trigger conditions that cause the source code
// to log errors (e.g. Firebase offline, cloud sync failure). Those stack traces
// are noise — the assertions in each test verify the actual behaviour.
// Tests that need to assert console.error was called can re-mock it locally.
jest.spyOn(console, "error").mockImplementation(() => {});

// ============================================================================
// REACT NATIVE MOCKS
// ============================================================================

// Helper: create a simple mock component that renders its children
const mockComponent = (name: string) => {
  const Component = React.forwardRef(({ children, ...props }: any, ref: any) =>
    React.createElement(name, { ...props, ref }, children),
  );
  Component.displayName = name;
  return Component;
};

// Mock react-native-svg
// __esModule: true is required so Babel CJS interop gives `import Svg from ...`
// the .default value instead of the whole module object.
jest.mock("react-native-svg", () => ({
  __esModule: true,
  default: mockComponent("Svg"),
  Svg: mockComponent("Svg"),
  Circle: mockComponent("Circle"),
  Rect: mockComponent("Rect"),
  Path: mockComponent("Path"),
  G: mockComponent("G"),
  Defs: mockComponent("Defs"),
  ClipPath: mockComponent("ClipPath"),
  LinearGradient: mockComponent("LinearGradient"),
  Stop: mockComponent("Stop"),
}));

// Mock expo-crypto
jest.mock("expo-crypto", () => {
  let callCounter = 0;
  return {
    getRandomBytes: jest.fn((byteCount: number) => {
      callCounter++;
      return new Uint8Array(byteCount).map(
        (_, i) => (callCounter * 37 + i * 17 + 0xab) & 0xff,
      );
    }),
    getRandomBytesAsync: jest.fn((byteCount: number) =>
      Promise.resolve(new Uint8Array(byteCount).fill(0xab)),
    ),
    digestStringAsync: jest.fn((_algorithm: string, _data: string) =>
      Promise.resolve(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ),
    ),
    CryptoDigestAlgorithm: {
      SHA256: "SHA-256",
    },
  };
});

// Mock expo-haptics
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: {
    Light: "Light",
    Medium: "Medium",
    Heavy: "Heavy",
  },
  NotificationFeedbackType: {
    Success: "Success",
    Warning: "Warning",
    Error: "Error",
  },
}));

// Mock expo-router
jest.mock("expo-router", () => ({
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
  },
  useRouter: jest.fn(() => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
  })),
  useLocalSearchParams: jest.fn(() => ({})),
  usePathname: jest.fn(() => "/"),
  useSegments: jest.fn(() => []),
  Link: "Link",
  Stack: { Screen: "Screen" },
  Tabs: { Screen: "Screen" },
}));

// Mock expo-linear-gradient
jest.mock("expo-linear-gradient", () => ({
  LinearGradient: "LinearGradient",
}));

// Mock @react-native-async-storage/async-storage
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
    clear: jest.fn(() => Promise.resolve()),
    getAllKeys: jest.fn(() => Promise.resolve([])),
    multiGet: jest.fn(() => Promise.resolve([])),
    multiSet: jest.fn(() => Promise.resolve()),
    multiRemove: jest.fn(() => Promise.resolve()),
  },
}));

// Mock expo-secure-store
jest.mock("expo-secure-store", () => ({
  setItemAsync: jest.fn(() => Promise.resolve()),
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

// Mock react-native-reanimated
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  default: {
    createAnimatedComponent: jest.fn(<T>(c: T) => c),
    View: "Animated.View",
    Text: "Animated.Text",
    Image: "Animated.Image",
    ScrollView: "Animated.ScrollView",
  },
  useSharedValue: jest.fn(<T>(initial: T) => ({ value: initial })),
  useAnimatedStyle: jest.fn(() => ({})),
  withTiming: jest.fn(<T>(value: T) => value),
  withSpring: jest.fn(<T>(value: T) => value),
  withDelay: jest.fn(<T>(_: number, animation: T) => animation),
  withSequence: jest.fn(<T>(...animations: T[]) => animations[0]),
  withRepeat: jest.fn(<T>(animation: T) => animation),
  Easing: {
    linear: jest.fn(),
    ease: jest.fn(),
    bezier: jest.fn(),
  },
  runOnJS: jest.fn(<T extends (...args: any[]) => any>(fn: T) => fn),
  interpolate: jest.fn(),
  Extrapolation: {
    CLAMP: "clamp",
    EXTEND: "extend",
    IDENTITY: "identity",
  },
}));

// Mock react-native-gesture-handler
jest.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: "GestureHandlerRootView",
  Gesture: {
    Tap: jest.fn(() => ({ onEnd: jest.fn().mockReturnThis() })),
    Pan: jest.fn(() => ({
      onUpdate: jest.fn().mockReturnThis(),
      onEnd: jest.fn().mockReturnThis(),
    })),
  },
  GestureDetector: "GestureDetector",
  TapGestureHandler: "TapGestureHandler",
  PanGestureHandler: "PanGestureHandler",
  ScrollView: "ScrollView",
  FlatList: "FlatList",
}));

// Mock expo (requireNativeModule etc.)
jest.mock("expo", () => ({
  requireNativeModule: jest.fn((_name: string) => ({})),
  NativeModule: class {},
}));

// Mock @react-native-firebase/auth (modular API)
const mockAuthInstance = {
  currentUser: null,
};
const mockSignInResult = (providerId: string, isNewUser = false) => ({
  user: {
    uid: "mock-uid",
    email: "test@example.com",
    displayName: "Test User",
    photoURL: null,
    phoneNumber: null,
    providerId,
  },
  additionalUserInfo: { isNewUser },
});
jest.mock("@react-native-firebase/auth", () => ({
  __esModule: true,
  // Modular API exports
  getAuth: jest.fn(() => mockAuthInstance),
  getIdToken: jest.fn((user: { getIdToken: () => Promise<string> }) =>
    user.getIdToken(),
  ),
  signInWithCredential: jest.fn(() =>
    Promise.resolve(mockSignInResult("google.com")),
  ),
  sendSignInLinkToEmail: jest.fn(() => Promise.resolve()),
  isSignInWithEmailLink: jest.fn(() => Promise.resolve(false)),
  signInWithEmailLink: jest.fn(() =>
    Promise.resolve(mockSignInResult("password")),
  ),
  signOut: jest.fn(() => Promise.resolve()),
  onAuthStateChanged: jest.fn(() => jest.fn()), // returns unsubscribe
  GoogleAuthProvider: { credential: jest.fn(() => "mock-google-credential") },
  AppleAuthProvider: { credential: jest.fn(() => "mock-apple-credential") },
  // Keep default export for any residual namespaced usage in tests
  default: Object.assign(
    jest.fn(() => mockAuthInstance),
    {
      GoogleAuthProvider: {
        credential: jest.fn(() => "mock-google-credential"),
      },
      AppleAuthProvider: { credential: jest.fn(() => "mock-apple-credential") },
    },
  ),
}));

// Mock @react-native-firebase/firestore (modular API)
const mockBatch = {
  set: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  commit: jest.fn(() => Promise.resolve()),
};
const mockDocRef = {
  id: "mock-id",
};
const mockDocSnap = {
  exists: false,
  id: "mock-id",
  data: () => null,
};
const mockFirestoreInstance = {};
jest.mock("@react-native-firebase/firestore", () => ({
  __esModule: true,
  // Modular API exports
  getFirestore: jest.fn(() => mockFirestoreInstance),
  collection: jest.fn(() => ({})),
  doc: jest.fn(() => mockDocRef),
  getDoc: jest.fn(() => Promise.resolve(mockDocSnap)),
  getDocs: jest.fn(() => Promise.resolve({ empty: true, docs: [] })),
  setDoc: jest.fn(() => Promise.resolve()),
  updateDoc: jest.fn(() => Promise.resolve()),
  deleteDoc: jest.fn(() => Promise.resolve()),
  writeBatch: jest.fn(() => mockBatch),
  onSnapshot: jest.fn(() => jest.fn()), // returns unsubscribe
  query: jest.fn((..._args: unknown[]) => ({})),
  where: jest.fn(() => ({})),
  limit: jest.fn(() => ({})),
  orderBy: jest.fn(() => ({})),
  serverTimestamp: jest.fn(() => "mock-server-timestamp"),
  arrayUnion: jest.fn((...items: unknown[]) => ({
    __type: "arrayUnion",
    items,
  })),
  arrayRemove: jest.fn((...items: unknown[]) => ({
    __type: "arrayRemove",
    items,
  })),
  Timestamp: {
    fromDate: jest.fn((d: Date) => ({
      toDate: () => d,
      seconds: Math.floor(d.getTime() / 1000),
      nanoseconds: 0,
    })),
    now: jest.fn(() => ({
      toDate: () => new Date(),
      seconds: Math.floor(Date.now() / 1000),
      nanoseconds: 0,
    })),
  },
  // Keep default export for any residual namespaced usage in tests
  default: Object.assign(
    jest.fn(() => mockFirestoreInstance),
    {
      FieldValue: {
        serverTimestamp: jest.fn(() => "mock-server-timestamp"),
        arrayUnion: jest.fn((...items: unknown[]) => ({
          __type: "arrayUnion",
          items,
        })),
        arrayRemove: jest.fn((...items: unknown[]) => ({
          __type: "arrayRemove",
          items,
        })),
        increment: jest.fn((n: number) => ({ __type: "increment", value: n })),
      },
      Timestamp: {
        fromDate: jest.fn((d: Date) => ({
          toDate: () => d,
          seconds: Math.floor(d.getTime() / 1000),
          nanoseconds: 0,
        })),
      },
    },
  ),
}));

// Mock @react-native-firebase/app-check
jest.mock("@react-native-firebase/app-check", () => {
  const mockInstance = {
    initializeAppCheck: jest.fn(() => Promise.resolve()),
    getToken: jest.fn(() => Promise.resolve({ token: "mock-app-check-token" })),
    newReactNativeFirebaseAppCheckProvider: jest.fn(() => ({
      configure: jest.fn(),
      getToken: jest.fn(() =>
        Promise.resolve({ token: "mock-app-check-token" }),
      ),
    })),
    setTokenAutoRefreshEnabled: jest.fn(),
  };
  const mockAppCheck: any = jest.fn(() => mockInstance);
  return {
    __esModule: true,
    default: mockAppCheck,
    initializeAppCheck: jest.fn(() => Promise.resolve(mockInstance)),
    getToken: jest.fn(() => Promise.resolve({ token: "mock-app-check-token" })),
    getLimitedUseToken: jest.fn(() =>
      Promise.resolve({ token: "mock-app-check-token" }),
    ),
    setTokenAutoRefreshEnabled: jest.fn(),
  };
});

// Mock @react-native-firebase/app (needed for app-check's getApp())
jest.mock("@react-native-firebase/app", () => ({
  __esModule: true,
  getApp: jest.fn(() => ({ name: "[DEFAULT]", appCheck: jest.fn() })),
  getApps: jest.fn(() => []),
  initializeApp: jest.fn(),
  default: jest.fn(() => ({ name: "[DEFAULT]" })),
}));

// Mock @react-native-firebase/messaging
jest.mock("@react-native-firebase/messaging", () => {
  const AuthorizationStatus = {
    NOT_DETERMINED: -1,
    DENIED: 0,
    AUTHORIZED: 1,
    PROVISIONAL: 2,
  };
  const mockMessaging: any = jest.fn(() => ({
    requestPermission: jest.fn(() => Promise.resolve(1)),
    getToken: jest.fn(() => Promise.resolve("mock-fcm-token")),
    getAPNSToken: jest.fn(() => Promise.resolve("mock-apns-token")),
    registerDeviceForRemoteMessages: jest.fn(() => Promise.resolve()),
    onTokenRefresh: jest.fn(() => jest.fn()),
    onMessage: jest.fn(() => jest.fn()),
    onNotificationOpenedApp: jest.fn(() => jest.fn()),
    setBackgroundMessageHandler: jest.fn(),
    getInitialNotification: jest.fn(() => Promise.resolve(null)),
  }));
  mockMessaging.AuthorizationStatus = AuthorizationStatus;

  const getMessaging = jest.fn(() => mockMessaging());

  return {
    __esModule: true,
    default: mockMessaging,
    AuthorizationStatus,
    getMessaging,
    requestPermission: jest.fn((instance: any, permissions?: unknown) =>
      instance.requestPermission(permissions),
    ),
    getToken: jest.fn((instance: any, options?: unknown) =>
      instance.getToken(options),
    ),
    getAPNSToken: jest.fn((instance: any) => instance.getAPNSToken()),
    registerDeviceForRemoteMessages: jest.fn((instance: any) =>
      instance.registerDeviceForRemoteMessages(),
    ),
    onTokenRefresh: jest.fn(
      (instance: any, listener: (token: string) => void) =>
        instance.onTokenRefresh(listener),
    ),
    onMessage: jest.fn((instance: any, listener: (message: unknown) => void) =>
      instance.onMessage(listener),
    ),
    onNotificationOpenedApp: jest.fn(
      (instance: any, listener: (message: unknown) => void) =>
        instance.onNotificationOpenedApp(listener),
    ),
    setBackgroundMessageHandler: jest.fn(
      (instance: any, handler: (message: unknown) => Promise<void>) =>
        instance.setBackgroundMessageHandler(handler),
    ),
    getInitialNotification: jest.fn((instance: any) =>
      instance.getInitialNotification(),
    ),
  };
});

// Mock expo-linking
jest.mock("expo-linking", () => ({
  createURL: jest.fn((path: string) => `niyah://${path}`),
  getInitialURL: jest.fn(() => Promise.resolve(null)),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  openURL: jest.fn(() => Promise.resolve()),
}));

// Mock expo-apple-authentication
jest.mock("expo-apple-authentication", () => ({
  signInAsync: jest.fn(() =>
    Promise.resolve({
      identityToken: "mock-apple-token",
      fullName: { givenName: "Test", familyName: "User" },
      email: "test@icloud.com",
    }),
  ),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  AppleAuthenticationButton: "AppleAuthenticationButton",
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  AppleAuthenticationButtonStyle: { WHITE: 0 },
}));

// Mock @react-native-google-signin/google-signin
jest.mock("@react-native-google-signin/google-signin", () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(() => Promise.resolve(true)),
    signIn: jest.fn(() =>
      Promise.resolve({ type: "success", data: { idToken: "mock-token" } }),
    ),
    signOut: jest.fn(() => Promise.resolve()),
    getTokens: jest.fn(() =>
      Promise.resolve({
        accessToken: "mock-access-token",
        idToken: "mock-id",
      }),
    ),
    getCurrentUser: jest.fn(() => null),
  },
  statusCodes: {
    SIGN_IN_CANCELLED: "SIGN_IN_CANCELLED",
    IN_PROGRESS: "IN_PROGRESS",
    PLAY_SERVICES_NOT_AVAILABLE: "PLAY_SERVICES_NOT_AVAILABLE",
  },
  isSuccessResponse: jest.fn(
    (response: { type?: string }) => response?.type === "success",
  ),
}));

// Mock react-native-safe-area-context
jest.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: "SafeAreaProvider",
  SafeAreaView: "SafeAreaView",
  useSafeAreaInsets: jest.fn(() => ({
    top: 44,
    bottom: 34,
    left: 0,
    right: 0,
  })),
}));

jest.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: ({ children }: { children: unknown }) => children,
  KeyboardAvoidingView: "KeyboardAvoidingView",
  KeyboardAwareScrollView: "KeyboardAwareScrollView",
}));

jest.mock("@notifee/react-native", () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn().mockResolvedValue(undefined),
    createChannel: jest.fn().mockResolvedValue("niyah-default"),
    onForegroundEvent: jest.fn(() => () => {}),
    onBackgroundEvent: jest.fn(),
  },
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  EventType: { PRESS: 1, DELIVERED: 3, DISMISSED: 0 },
}));

// ============================================================================
// TEST UTILITIES
// ============================================================================

// clearMocks: true in jest.config.js handles mock cleanup between tests

/**
 * Helper to reset zustand stores between tests
 */
export const resetStore = <T extends object>(
  store: { setState: (state: Partial<T>) => void; getInitialState?: () => T },
  initialState: T,
): void => {
  store.setState(initialState);
};

/**
 * Wait for all pending promises to resolve
 */
export const flushPromises = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Advance timers and flush promises
 */
export const advanceTimersAndFlush = async (ms: number): Promise<void> => {
  jest.advanceTimersByTime(ms);
  await flushPromises();
};
