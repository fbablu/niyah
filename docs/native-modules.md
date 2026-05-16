# Native Modules

> Firebase, Screen Time, and config plugins.
> See also: [Architecture](./architecture.md) | [Roadmap](./roadmap.md) | [Security](./security.md)

## Firebase (RNFB)

React Native Firebase packages provide Auth and Firestore:

| Package                            | Purpose                                                |
| ---------------------------------- | ------------------------------------------------------ |
| `@react-native-firebase/app`       | Core initialization (Expo plugin in `app.config.ts`)   |
| `@react-native-firebase/auth`      | Google, Apple, email magic link, and phone SMS sign-in |
| `@react-native-firebase/firestore` | User profiles, wallets, sessions, follows              |
| `@react-native-firebase/messaging` | FCM push notifications (token management, foreground)  |

**Config files**: `GoogleService-Info.plist` (iOS) and `google-services.json` (Android) live in `firebase/` (gitignored). Injected at build time by the `withGoogleServicesPlist` and `withGoogleServicesJson` config plugins. `withFirebaseStaticFrameworks` handles CocoaPods static framework linking.

**JS wrapper**: `src/config/firebase.ts` -- all auth, Firestore CRUD, and social helpers.

## Screen Time Module (`modules/niyah-screentime/`)

Custom Expo module bridging iOS Screen Time API to JavaScript.

### Swift Components

| File                                   | Purpose                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NiyahScreenTimeModule.swift`          | FamilyControls auth, FamilyActivityPicker, ManagedSettings shield (block/unblock). App selection persisted via App Groups `UserDefaults` with `PropertyListEncoder`. Polls for violations and emits `onShieldViolation` events to JS. |
| `AppPickerHostingController.swift`     | SwiftUI wrapper for `FamilyActivityPicker`, presented modally as `UIHostingController`. Supports Done and Cancel callbacks.                                                                                                           |
| `DeviceActivityMonitorExtension.swift` | App Extension (separate process). Detects blocked app opens during sessions, records violation timestamps to shared `UserDefaults`. Uses named `ManagedSettingsStore(.niyahSession)`.                                                 |
| `ShieldActionExtension.swift`          | Handles user actions on the shield overlay (e.g., "Surrender Session" button tap). Communicates back to main app.                                                                                                                     |
| `ShieldConfigurationExtension.swift`   | Configures custom shield appearance — Niyah-branded overlay with "Stay Focused" / "Surrender Session" buttons instead of generic system block.                                                                                        |

### JS Wrapper

`src/config/screentime.ts` -- typed convenience functions for:

- Authorization (`requestAuthorization`)
- App picker (`presentAppPicker`)
- Blocking (`startBlocking` / `stopBlocking`)
- Violation events (`onShieldViolation` subscription)

### Config Plugins

| Plugin                         | What it does                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withScreenTimeEntitlement.js` | Adds FamilyControls, App Groups (`group.com.niyah.app`), Push Notifications entitlements                                                                                     |
| `withDeviceActivityMonitor.js` | Injects DeviceActivityMonitor extension target into Xcode project. Reads `config.version` for dynamic versioning. Extension embed phase currently disabled (see note below). |

### Requirements

- iOS 16+, physical device only (no Simulator)
- FamilyControls entitlement enabled on App ID (Apple Developer portal)

### Status

Swift code is production-quality. JS wrapper complete. Custom shield UI built and branded. Quick-block flow (`quick-block.tsx`) and group session flow (`active.tsx`) are wired to `startBlocking()`/`stopBlocking()`. Shield surrender desync fixed: shield sets `niyah_surrender_requested` flag + opens app via deep link, JS listener catches it and calls `stopBlocking()`. Scheduled blocking APIs (`startScheduledBlocking`/`stopScheduledBlocking`) exported but deferred post-demo.

The extension embed phase in `withDeviceActivityMonitor.js` is intentionally disabled (caused `lstat` build failures). Will be re-enabled when Screen Time is fully wired into sessions. See [Roadmap](./roadmap.md).

### Custom Shield UX

The custom Niyah-branded shield is implemented via `ShieldConfigurationExtension.swift` and `ShieldActionExtension.swift`:

- User starts a focus session (or quick block) and selects distraction apps
- Opening a restricted app shows a **custom shield screen** with Niyah branding
- Two options: **"Surrender Session"** (lose stake, end session) or **"Stay Focused"** (dismiss, return)
- Button actions handled by `ShieldActionExtension`, which communicates back to the main app

iOS does not allow injecting modals into other apps. The custom shield via `ManagedSettingsStore` is the only API-compliant approach.

## Planned iOS Extension Targets (Post-Demo)

These two new extensions are scoped in [post-demo-roadmap.md](./post-demo-roadmap.md) Lane B and unblock several premium-UX features. Both are **build-required** — no JS-only fallback.

### `NiyahDeviceActivityReport`

iOS 16+ app extension built on the `DeviceActivityReport` API — the only sanctioned way to read per-app usage data on a non-MDM device. Surfaces aggregated daily/weekly usage for the user's selected `FamilyActivitySelection` categories.

| File | Purpose |
| ---- | ------- |
| `ios/NiyahDeviceActivityReport/DeviceActivityReport.swift` | Extension entry point with SwiftUI scenes for daily/weekly views. |
| `ios/NiyahDeviceActivityReport/Info.plist` | Bundle id `com.niyah.app.device-activity-report`, FamilyControls Distribution entitlement attached. |
| App Group `UserDefaults` (`group.com.niyah.app`) | Extension writes baseline snapshots (top apps + daily-average minutes per category). Main app reads via `getScreenTimeBaseline()`. |

Bridge method on `NiyahScreenTimeModule.swift`:

```swift
func getScreenTimeBaseline() -> [(appToken, dailyAverageMinutes, weeklyTotal, category)]
```

JS wrapper in `src/config/screentime.ts`. Powers:

- Redesigned app-selection onboarding (Lane B3 — "Select all apps to monitor" + per-app prioritization with usage badges).
- Group equity cap-target model (see [Group Equity](./group-equity.md)) — provides the trusted `baselineMs` input to `calculatePayouts`.

Plugin: `plugins/withScreenTimeExtensions.ts` is extended to register the new target alongside `device-activity-monitor`, `shield-action`, `shield-config`.

### `NiyahLiveActivity`

ActivityKit + WidgetKit widget extension for **lock-screen + Dynamic Island** in-session UX.

| Layout | Content |
| ------ | ------- |
| Lock screen | Niyah blob, big timer, top-3 leaderboard with status dots + violation counts. |
| Dynamic Island (compact) | Timer + blob mark. |
| Dynamic Island (expanded) | Timer + 3-row leaderboard. |
| Minimal | Timer only. |

`ActivityAttributes` carries `sessionId`, `sessionType` (solo/group), `endsAt`, `blobAssetName`, and a compact leaderboard array (name + status + violations).

Bridge methods (on a new `NiyahLiveActivityModule.swift` or extended `NiyahScreenTimeModule.swift`):

```swift
func startLiveActivity(attrs)
func updateLiveActivity(state)
func endLiveActivity()
```

Wired into `src/store/sessionStore.ts` (solo) and `src/store/groupSessionStore.ts` (group):

- Session start → `startLiveActivity`.
- Each Firestore session-doc tick (`subscribeToSession`) → `updateLiveActivity`.
- Complete / surrender → `endLiveActivity`.

App Group `UserDefaults` is reused for cross-process leaderboard state so the widget timeline provider can render without an active JS bridge.

## Key Apple Frameworks Reference

| Framework             | Purpose                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| FamilyControls        | Authorization & privacy tokens for selecting apps/websites                    |
| ManagedSettings       | Apply restrictions (shield apps), `ShieldConfiguration` for custom UI         |
| DeviceActivity        | Monitor usage, execute code on schedules/events, handle shield actions        |
| DeviceActivityReport  | Read aggregated per-app/category usage; powers baseline + cap-target equity   |
| ActivityKit + WidgetKit | Lock-screen & Dynamic Island Live Activities for in-session presence        |
