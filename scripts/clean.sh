#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# clean.sh — Safe disk cleanup for iOS / Expo / pnpm development caches.
#
# Wipes only caches (regenerate on next build). Does NOT touch:
#   - node_modules / ios/Pods (those force a reinstall, not "cache")
#   - iOS DeviceSupport (slow symbol re-extract on next device connect)
#   - Simulator runtimes (multi-GB redownload)
#   - Simulator app state (xcrun simctl erase all)
#
# For those, see docs/cleanup.md.
#
# Usage: pnpm clean
# ──────────────────────────────────────────────────────────────────────────────

set -u

# Run from repo root (script may be invoked from anywhere)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

free_before=$(df -h / | awk 'NR==2 {print $4}')
echo "${BOLD}Niyah clean${RESET} ${DIM}(free disk before: $free_before)${RESET}"
echo

step() {
  printf "  %s%s%s " "$YELLOW" "→" "$RESET"
  printf "%s" "$1"
}
done_() {
  printf " %s✓%s\n" "$GREEN" "$RESET"
}

# ── Xcode ─────────────────────────────────────────────────────────────────────
step "Xcode DerivedData"
rm -rf ~/Library/Developer/Xcode/DerivedData/* 2>/dev/null
done_

step "Xcode app cache"
rm -rf ~/Library/Caches/com.apple.dt.Xcode/* 2>/dev/null
done_

step "Xcode ModuleCache"
rm -rf ~/Library/Developer/Xcode/DerivedData/ModuleCache.noindex 2>/dev/null
done_

# ── Simulator (logs only — keeps sims + their state) ──────────────────────────
step "Simulator logs"
rm -rf ~/Library/Logs/CoreSimulator/* 2>/dev/null
done_

step "Simulators marked unavailable"
xcrun simctl delete unavailable >/dev/null 2>&1 || true
done_

# ── Metro / Haste / Jest temp ─────────────────────────────────────────────────
step "Metro / Haste / Jest tmp"
rm -rf "${TMPDIR:-/tmp}"/metro-* "${TMPDIR:-/tmp}"/haste-* "${TMPDIR:-/tmp}"/jest_dx 2>/dev/null
done_

# ── Expo / EAS ────────────────────────────────────────────────────────────────
step "Global ~/.expo"
rm -rf ~/.expo 2>/dev/null
done_

step "Global ~/.eas-cli"
rm -rf ~/.eas-cli 2>/dev/null
done_

step "Project .expo"
rm -rf ./.expo 2>/dev/null
done_

# ── CocoaPods cache ───────────────────────────────────────────────────────────
step "CocoaPods cache"
rm -rf ~/Library/Caches/CocoaPods 2>/dev/null
done_

# ── Project build artifacts (not Pods themselves) ─────────────────────────────
step "Project ios/build"
rm -rf ./ios/build 2>/dev/null
done_

# ── pnpm store (unused packages only — safe) ──────────────────────────────────
step "pnpm store prune"
pnpm store prune >/dev/null 2>&1 || true
done_

echo
free_after=$(df -h / | awk 'NR==2 {print $4}')
echo "${BOLD}Done.${RESET} Free disk: $free_before → ${GREEN}$free_after${RESET}"
echo "${DIM}For deeper cleanup (node_modules, Pods, DeviceSupport, sim runtimes) see docs/cleanup.md${RESET}"
