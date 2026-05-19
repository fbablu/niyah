#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# clean-deep.sh — Full reset of installed deps + caches, then reinstall.
#
# Runs the safe `pnpm clean` first, then nukes install dirs:
#   - node_modules
#   - ios/Pods
#   - ios/build
# Then reinstalls from existing lockfiles (pnpm-lock.yaml, Podfile.lock).
# Lockfiles are NOT deleted — version changes should be intentional, not a
# side effect of cleaning. To bust lockfiles, do it manually.
#
# Takes ~3–5 min (pod install dominates).
#
# Usage: pnpm clean:deep
# ──────────────────────────────────────────────────────────────────────────────

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

echo "${BOLD}Niyah clean:deep${RESET} ${DIM}(safe cache wipe + reinstall — takes 3–5 min)${RESET}"
echo

# ── Phase 1: safe caches ──────────────────────────────────────────────────────
echo "${BOLD}[1/3]${RESET} Running pnpm clean..."
bash "$SCRIPT_DIR/clean.sh"
echo

# ── Phase 2: nuke install dirs ────────────────────────────────────────────────
echo "${BOLD}[2/3]${RESET} Removing install dirs..."
printf "  %s→%s node_modules" "$YELLOW" "$RESET"
rm -rf ./node_modules
printf " %s✓%s\n" "$GREEN" "$RESET"

printf "  %s→%s ios/Pods" "$YELLOW" "$RESET"
rm -rf ./ios/Pods
printf " %s✓%s\n" "$GREEN" "$RESET"

printf "  %s→%s ios/build" "$YELLOW" "$RESET"
rm -rf ./ios/build
printf " %s✓%s\n" "$GREEN" "$RESET"
echo

# ── Phase 3: reinstall ────────────────────────────────────────────────────────
echo "${BOLD}[3/3]${RESET} Reinstalling..."
echo "  ${YELLOW}→${RESET} pnpm install"
pnpm install
echo
echo "  ${YELLOW}→${RESET} pod install"
cd ios && pod install && cd ..
echo

free_after=$(df -h / | awk 'NR==2 {print $4}')
echo "${BOLD}Done.${RESET} Free disk: ${GREEN}$free_after${RESET}"
echo "${DIM}Next: pnpm start --clear (Metro fresh cache)${RESET}"
