# iOS / Expo Dev Cleanup

Disk fills fast on this stack. DerivedData, simulators, and iOS DeviceSupport are biggest. Run weekly during active dev.

## TL;DR scripts

```bash
pnpm clean        # safe cache wipe (~10s, ~10–15G back, no reinstall needed)
pnpm clean:deep   # above + nuke node_modules/Pods + reinstall (~3–5min)
```

Lockfiles (`pnpm-lock.yaml`, `ios/Podfile.lock`) are never auto-deleted — version changes should be intentional.

## Current top hogs (snapshot 2026-05-17)

| Path                                          | Size  | Safe to nuke? |
| --------------------------------------------- | ----- | ------------- |
| `~/Library/Developer/Xcode/DerivedData`       | 9.7G  | Yes           |
| `~/Library/Developer/CoreSimulator`           | 5.8G  | Mostly        |
| `~/Library/Developer/Xcode/iOS DeviceSupport` | 5.5G  | Yes           |
| `~/Library/pnpm` (global store)               | 2.2G  | Yes           |
| `ios/Pods` (per-project)                      | 1.1G  | Yes           |
| `$TMPDIR/metro-*` + `haste-*`                 | 1.0G  | Yes           |
| `~/Library/Caches/CocoaPods`                  | 903M  | Yes           |
| `~/.expo`                                     | 797M  | Yes           |
| `node_modules` (per-project)                  | 790M  | Yes           |
| `~/Library/Caches/pnpm`                       | 405M  | Yes           |

Re-check anytime:

```bash
du -sh \
  ~/Library/Developer/Xcode/DerivedData \
  ~/Library/Developer/Xcode/Archives \
  ~/Library/Developer/Xcode/"iOS DeviceSupport" \
  ~/Library/Developer/CoreSimulator \
  ~/Library/Caches/CocoaPods \
  ~/Library/Caches/pnpm \
  ~/Library/pnpm \
  ~/.expo \
  ~/.eas-cli \
  "$TMPDIR" \
  2>/dev/null | sort -hr
```

## One-shot deep clean (~20G+ back)

Run from project root. Skips simulators (those wipe app state). Re-pod + re-install after.

```bash
# Xcode
rm -rf ~/Library/Developer/Xcode/DerivedData/*
rm -rf ~/Library/Developer/Xcode/Archives/*
rm -rf ~/Library/Developer/Xcode/"iOS DeviceSupport"/*
rm -rf ~/Library/Caches/com.apple.dt.Xcode/*

# CocoaPods
rm -rf ~/Library/Caches/CocoaPods
rm -rf ~/.cocoapods/repos/trunk/Specs  # giant spec mirror, regenerates

# Metro / Haste / Jest temp
rm -rf "$TMPDIR"/metro-* "$TMPDIR"/haste-* "$TMPDIR"/jest_dx

# Expo / EAS
rm -rf ~/.expo
rm -rf ~/.eas-cli

# Project (cd in first)
rm -rf node_modules ios/Pods ios/build .expo

# pnpm store (safe; re-populates on next install)
pnpm store prune
```

Then rebuild:

```bash
pnpm install
cd ios && pod install && cd ..
pnpm start --clear
```

## By category

### Xcode

```bash
# DerivedData — build artifacts. Biggest single win. Always safe.
rm -rf ~/Library/Developer/Xcode/DerivedData/*

# Archives — only matters if shipping via Organizer. EAS Build = safe to nuke.
rm -rf ~/Library/Developer/Xcode/Archives/*

# iOS DeviceSupport — symbols for each connected device/OS combo.
# Regenerates on next device connect. Slow first-connect, then fine.
rm -rf ~/Library/Developer/Xcode/"iOS DeviceSupport"/*

# Xcode app cache
rm -rf ~/Library/Caches/com.apple.dt.Xcode/*

# Module cache (fixes weird "module not found" errors too)
rm -rf ~/Library/Developer/Xcode/DerivedData/ModuleCache.noindex
```

### Simulators

```bash
# Erase content+settings on ALL sims (keeps sims, wipes their data)
xcrun simctl erase all

# Delete sims marked unavailable (old Xcode versions)
xcrun simctl delete unavailable

# List installed runtimes
xcrun simctl list runtimes

# Delete specific old iOS runtime (frees ~5–8G each)
# WARNING: Permanent. Re-download from Xcode > Settings > Platforms if needed.
xcrun simctl runtime delete "iOS 18.3"
xcrun simctl runtime delete "iOS 18.6"
```

You have iOS 18.3, 18.6, 26.0, 26.3 runtimes installed. Drop 18.x unless still testing on those.

### CocoaPods

```bash
# Global pod cache
rm -rf ~/Library/Caches/CocoaPods
pod cache clean --all

# Trunk specs repo — 200MB+, regenerates on pod install
rm -rf ~/.cocoapods/repos/trunk

# Per-project (cd to project)
rm -rf ios/Pods ios/build ios/Podfile.lock
cd ios && pod install && cd ..
```

### Expo / Metro / EAS

```bash
# Expo CLI cache (templates, downloaded dev clients)
rm -rf ~/.expo

# EAS CLI cache
rm -rf ~/.eas-cli

# Project .expo
rm -rf .expo

# Metro / Haste / Jest temp (in TMPDIR, gets large fast)
rm -rf "$TMPDIR"/metro-* "$TMPDIR"/haste-* "$TMPDIR"/jest_dx

# Start Metro with fresh cache
pnpm start --clear
# or
npx expo start --clear
```

### pnpm / node

```bash
# Global pnpm store (content-addressable, dedup'd across projects)
pnpm store prune              # remove unused only
rm -rf ~/Library/pnpm         # nuke entire store (re-downloads on next install)
rm -rf ~/Library/Caches/pnpm

# Per-project
rm -rf node_modules
pnpm install
```

### Misc

```bash
# Sim logs
rm -rf ~/Library/Logs/CoreSimulator/*

# Diagnostic reports
rm -rf ~/Library/Logs/DiagnosticReports/*

# Homebrew
brew cleanup -s
rm -rf "$(brew --cache)"

# Watchman (if installed; sometimes leaks state)
watchman watch-del-all
```

## Schedule

| When                          | Run                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Daily (after long Xcode day)  | `rm -rf ~/Library/Developer/Xcode/DerivedData/*`                                                              |
| Weekly                        | DerivedData + Metro/Haste temp + `pnpm store prune` + project `ios/build`                                     |
| Monthly                       | Full deep clean (above), drop unused sim runtimes, `pod cache clean --all`                                    |
| When disk < 5G                | Deep clean + drop old iOS runtimes + nuke `iOS DeviceSupport`                                                 |
| After major Xcode upgrade     | `xcrun simctl delete unavailable` + nuke DerivedData + nuke ModuleCache                                       |
| Before fresh `pod install`    | `rm -rf ios/Pods ios/Podfile.lock ios/build` + DerivedData                                                    |

## Irreversible / careful list

These wipe state, not just cache. Confirm before running.

- `xcrun simctl erase all` — wipes app data, keychain, photos on every simulator. App reinstalls fresh on next run.
- `xcrun simctl runtime delete "iOS X.Y"` — permanent until re-downloaded from Xcode > Settings > Platforms (multi-GB redownload).
- `xcrun simctl delete unavailable` — only touches sims Xcode already flagged as broken; safe.
- Deleting `iOS DeviceSupport` — next device connect re-extracts symbols (slow once, ~5min).
- Deleting `~/Library/pnpm` — next `pnpm install` re-downloads every package across every project on the machine.

## Project-only quick reset

For when only this repo acts weird, not the whole machine:

```bash
cd /Users/fardeenb/Documents/Projects/niyah
rm -rf node_modules ios/Pods ios/build .expo
rm -rf "$TMPDIR"/metro-* "$TMPDIR"/haste-*
pnpm install
cd ios && pod install && cd ..
pnpm start --clear
```
