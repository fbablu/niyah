# Development

> Commands, environment setup, and build workflow.
> See also: [Architecture](./architecture.md) | [Security](./security.md)

## Prerequisites

- **Node.js** v18+
- **pnpm** (`npm install -g pnpm`)
- **Xcode** (iOS) -- install from Mac App Store, then `xcode-select --install`
- **Android SDK** (Android) -- via [Android Studio](https://developer.android.com/studio)
- **EAS CLI** -- `npm install -g eas-cli` (for cloud builds)

## Environment Variables

Copy `.env.example` to `.env` and fill in values:

| Variable                               | Purpose                                                           |
| -------------------------------------- | ----------------------------------------------------------------- |
| `EXPO_PUBLIC_FIREBASE_PROJECT_ID`      | Firebase project ID (used in dynamic config, Cloud Functions URL) |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`     | Google OAuth web client ID                                        |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`     | Google OAuth iOS client ID (also derives URL scheme)              |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` | Google OAuth Android client ID                                    |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`   | Stripe publishable key (`pk_test_...` or `pk_live_...`)           |

**Server-side secrets** (never in `.env`):

- `STRIPE_SECRET_KEY` -- Firebase Secret Manager (`firebase functions:secrets:set`)
- `STRIPE_WEBHOOK_SECRET` -- Firebase Secret Manager

**Firebase config files** (gitignored, required on disk):

- `firebase/GoogleService-Info.plist` -- download from Firebase Console > Project Settings > iOS app
- `firebase/google-services.json` -- download from Firebase Console > Project Settings > Android app

For EAS cloud builds, upload these as file secrets:

```bash
eas secret:create --scope project --name GOOGLE_SERVICE_INFO_PLIST --type file --value firebase/GoogleService-Info.plist
eas secret:create --scope project --name GOOGLE_SERVICES_JSON --type file --value firebase/google-services.json
```

## Commands

### Development Server

```bash
pnpm start             # Start dev server (requires dev client build first)
pnpm doctor            # Diagnose Mac+iPhone dev state, recommend next command
pnpm ios               # Start with iOS simulator
pnpm android           # Start with Android emulator
npx expo start --clear # Clear cache and start
```

### Testing

```bash
pnpm test              # All tests once (1018 tests, 48 suites)
pnpm test:watch        # Watch mode
pnpm test:coverage     # Coverage report
pnpm test:integration  # Integration tests only
pnpm test:unit         # Unit tests only
pnpm test:stores       # Store tests only
pnpm test:components   # Component tests only
```

### Code Quality

```bash
pnpm typecheck         # TypeScript strict mode check
pnpm lint              # ESLint 9
pnpm lint:fix          # Auto-fix lint issues
pnpm format            # Prettier format
pnpm format:check      # Check formatting
pnpm ci                # lint + typecheck + test (full CI check)
```

### Building

```bash
pnpm build:local       # iOS local build to USB device (fastest, requires Xcode)
pnpm build:local:sim   # iOS local build to Simulator
pnpm build:dev         # iOS dev build via EAS (cloud)
pnpm build:dev:android # Android dev build via EAS (cloud)
pnpm build:dev:device  # iOS device-specific dev build via EAS
pnpm build:preview     # Preview build (all platforms)
pnpm build:production  # Production build (all platforms)
```

**Important**: This project uses `expo-dev-client`, NOT Expo Go. Build a dev client first (`pnpm build:local` or `pnpm build:dev`) before running `pnpm start`.

## Physical Device Development

iOS dev client cannot fetch the JS bundle over USB cable alone — Apple has no equivalent of `adb reverse`. Metro requires IP connectivity between Mac and phone. Three viable transports:

### Same wifi (best)

Mac and phone on the same network. Phone connects to Metro at Mac's LAN IP. Works on home wifi and on public wifi without client isolation.

```bash
pnpm build:local       # build + install on device (USB cable)
pnpm start             # Metro on Mac, phone auto-discovers via LAN
```

### iPhone hotspot

When you're on a network you don't control (cafe, campus, hotel) and want guaranteed connectivity. Enable Personal Hotspot on the iPhone, join it from the Mac, then run `pnpm start`. Mac + phone now share NAT, LAN discovery works.

### Ngrok tunnel

Cross-network fallback (`pnpm start --tunnel`). Often blocked by public-wifi DPI; ngrok tunnel handshake fails with `remote gone away`. Don't depend on this — `pnpm doctor` probes ngrok reachability before recommending.

### Diagnose first

```bash
pnpm doctor            # prints state of USB, DDI, network, pods; recommends command
```

## Cloud Functions

24 Cloud Functions deployed to Firebase:

| Function                   | Purpose                                       |
| -------------------------- | --------------------------------------------- |
| `createPaymentIntent`      | Stripe deposit PaymentIntent                  |
| `verifyAndCreditDeposit`   | Verify payment + credit wallet                |
| `createConnectAccount`     | Create Stripe Connect account                 |
| `createAccountLink`        | Generate Stripe Connect onboarding URL        |
| `getConnectAccountStatus`  | Check Connect account status                  |
| `createPlaidLinkToken`     | Create Plaid Link token for bank connection   |
| `linkBankAccount`          | Link bank account via Plaid → Stripe          |
| `handleSessionComplete`    | Process session completion + payout           |
| `handleSessionForfeit`     | Process session surrender + forfeit           |
| `requestWithdrawal`        | Initiate Stripe payout                        |
| `distributeGroupPayouts`   | Calculate + distribute group session pool     |
| `createGroupSession`       | Create group session + send invites           |
| `respondToGroupInvite`     | Accept/decline group invite                   |
| `markOnlineForSession`     | Signal ready for group session                |
| `startGroupSession`        | Start group session (proposer action)         |
| `reportSessionStatus`      | Report completion/surrender for group session |
| `cancelGroupSession`       | Cancel group session (proposer)               |
| `autoTimeoutGroupSessions` | Auto-cancel stale sessions (scheduled, 5 min) |
| `awardReferral`            | Process referral bonus                        |
| `followUserFn`             | Follow a user                                 |
| `unfollowUserFn`           | Unfollow a user                               |
| `findContactsOnNiyah`      | Search contacts against user directory        |
| `acceptLegalTerms`         | Record T&C acceptance with server timestamp   |
| `stripeWebhook`            | Handle Stripe webhook events                  |

Deploy: `firebase deploy --only functions`
Deploy rules: `firebase deploy --only firestore:rules`

**Note**: `functions/package.json` has a `"lint": "tsc --noEmit"` script required by `firebase.json` predeploy hooks.
