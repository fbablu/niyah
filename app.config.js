/**
 * Dynamic Expo config — replaces app.json so project-specific identifiers
 * (Firebase project ID, Google OAuth client IDs) come from .env rather than
 * being hardcoded in source control.
 *
 * See .env.example for required environment variables.
 */

function env(name, fallback) {
  const value = process.env[name];
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(
    `Missing required env var: ${name}. Copy .env.example to .env and fill in values.`,
  );
}

const firebaseProjectId = env("EXPO_PUBLIC_FIREBASE_PROJECT_ID");
const googleIosClientId = env("EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID");
const googleIosShortId = googleIosClientId.replace(
  /\.apps\.googleusercontent\.com$/,
  "",
);

module.exports = {
  expo: {
    name: "Niyah",
    slug: "niyah",
    owner: "niyah-app",
    version: "1.0.0",
    scheme: "niyah",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "dark",
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.niyah.app",
      buildNumber: "11",
      appleTeamId: "4R55F73KCP",
      googleServicesFile:
        process.env.GOOGLE_SERVICE_INFO_PLIST ||
        "./firebase/GoogleService-Info.plist",
      usesAppleSignIn: true,
      associatedDomains: [`applinks:${firebaseProjectId}.firebaseapp.com`],
      entitlements: {
        "com.apple.developer.family-controls": true,
        "com.apple.security.application-groups": ["group.com.niyah.app"],
        "aps-environment": "production",
      },
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        UIBackgroundModes: ["remote-notification", "fetch"],
        NSSupportsLiveActivities: true,
        NSFamilyControlsUsageDescription:
          "Niyah needs Screen Time access to block distracting apps during your focus sessions.",
        NSContactsUsageDescription:
          "Niyah uses your contacts to invite friends to focus sessions.",
        NSCameraUsageDescription:
          "Niyah may use the camera to scan payment cards during deposit or verify identity for payouts.",
        NSPhotoLibraryUsageDescription:
          "Niyah may access your photo library to select a profile picture.",
        NSMicrophoneUsageDescription:
          "Niyah does not record audio. This permission is required by included payment SDKs.",
        NSFaceIDUsageDescription:
          "Niyah may use Face ID to confirm sensitive transactions.",
        NSUserTrackingUsageDescription:
          "Niyah does not track you across other apps.",
        NSLocationWhenInUseUsageDescription:
          "Niyah does not collect location. This permission is referenced by included SDKs.",
      },
    },
    android: {
      googleServicesFile:
        process.env.GOOGLE_SERVICES_JSON || "./firebase/google-services.json",
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#1A1714",
      },
      package: "com.niyah.app",
      edgeToEdgeEnabled: true,
      intentFilters: [
        {
          action: "VIEW",
          autoVerify: true,
          data: [
            {
              scheme: "https",
              host: `${firebaseProjectId}.firebaseapp.com`,
              pathPrefix: "/",
            },
          ],
          category: ["BROWSABLE", "DEFAULT"],
        },
      ],
    },
    web: {
      favicon: "./assets/favicon.png",
      bundler: "metro",
    },
    plugins: [
      [
        "expo-splash-screen",
        {
          image: "./assets/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#2D6A4F",
        },
      ],
      "expo-router",
      "react-native-bottom-tabs",
      "@react-native-firebase/app",
      "@react-native-firebase/messaging",
      [
        "@react-native-google-signin/google-signin",
        {
          iosUrlScheme: `com.googleusercontent.apps.${googleIosShortId}`,
        },
      ],
      "expo-apple-authentication",
      "expo-contacts",
      [
        "@stripe/stripe-react-native",
        {
          merchantIdentifier: "merchant.com.niyah.app",
          enableGooglePay: false,
        },
      ],
      "./plugins/withFollyCoroutinesFix",
      "./plugins/withFmtConstevalFix",
      "./plugins/withGoogleServicesPlist",
      "./plugins/withGoogleServicesJson",
      "./plugins/withFirebaseStaticFrameworks",
      "./plugins/withResourceBundleSigning",
      "@bacons/apple-targets",
    ],
    experiments: {
      typedRoutes: true,
    },
    nativeModulesDir: "modules",
    extra: {
      router: {},
      eas: {
        projectId: "dea6379a-e2c1-4e15-8d7e-3dc25f03b59b",
      },
    },
  },
};
