# Team Setup & Distribution

Setup guide for teammates and build distribution. For the core dev setup, see the [README](../README.md); for the full command reference, see [development.md](development.md).

## Teammate Setup (Windows + iPhone, no Mac needed)

The Mac owner builds the app once and shares an install link. Teammates install it on their iPhones and code with live hot-reload from their Windows laptops.

### 1. Install the app on your iPhone

- Open the install link you received in **Safari** on your iPhone
- Tap **Install** when prompted
- Go to **Settings > General > VPN & Device Management** > tap the developer certificate > **Trust**

### 2. Set up your dev environment (one-time)

Install WSL2: `wsl --install` from PowerShell, then restart. Inside WSL:

```bash
# Install Node.js 18+ and pnpm, then:
git clone <repo-url>
cd niyah
pnpm install
```

Set up config files (never commit these):

- `.env` — copy `.env.example`, fill in values from [Firebase Console](https://console.firebase.google.com/) and [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
- `firebase/GoogleService-Info.plist` — Firebase Console > Project Settings > Your Apps > iOS > download
- `firebase/google-services.json` — Firebase Console > Project Settings > Your Apps > Android > download

You need to be added to the Firebase project first — ask the team lead.

### 3. Network setup (every Windows restart)

Open **PowerShell as Administrator** on the Windows side:

```powershell
.\scripts\wsl_dev_setup.ps1
```

Note the Wi-Fi IP it prints at the end.

### 4. Start coding

```bash
pnpm start   # inside WSL
```

Open the Niyah app on your iPhone. Enter the Metro URL: `http://<your-wifi-ip>:8081`

All JS/TS code changes hot-reload instantly on your phone.

---

## Building for Team Distribution (Mac owner only)

### Option A: EAS Cloud (easiest)

```bash
set -a && source .env && set +a
eas build --profile development-device --platform ios
```

EAS gives you an install link at the end. Share it with teammates.

### Option B: Local via Xcode (no queue)

```bash
npx expo prebuild --platform ios
cd ios && pod install && cd ..
open ios/Niyah.xcworkspace
```

In Xcode:

1. Set destination to **Any iOS Device (arm64)**
2. **Product > Archive**
3. **Distribute App > Release Testing > Export**
4. Upload the `.ipa` to [diawi.com](https://diawi.com) and share the link

### Registering new devices

```bash
eas device:create   # generates URL — send to teammate to open on their iPhone
```

After registering, rebuild and redistribute.

---

## Troubleshooting

**Clear cache:**

```bash
npx expo start --clear
```

**Reinstall node_modules:**

```bash
rm -rf node_modules
pnpm install
```

**iOS rebuild:**

```bash
rm -rf ios
npx expo prebuild --platform ios --clean
npx expo run:ios
```

**Android rebuild:**

```bash
rm -rf android
npx expo prebuild --platform android --clean
npx expo run:android
```

**Clean everything:**

```bash
rm -rf node_modules ios android .expo
pnpm install
npx expo prebuild --clean
npx expo run:ios
```

**Metro won't connect on Windows:**

- Make sure `wsl_dev_setup.ps1` ran after last restart
- Check that phone and laptop are on the same WiFi
- Try entering the URL manually: `http://<wifi-ip>:8081`

### Android Environment Setup

Add to `~/.zshrc` or `~/.bashrc`:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
```

Create AVD: Android Studio > Virtual Device Manager > Pixel 9 / API 35.

If the dev client doesn't auto-connect:

```bash
adb reverse tcp:8081 tcp:8081
```
