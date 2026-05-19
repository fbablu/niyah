#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# dev-doctor.sh — Diagnose Mac + iPhone dev environment, recommend next step.
#
# Run before any dev session, especially on public wifi / hotspot. Detects:
#   - USB-connected iPhone (UDID, iOS version, model)
#   - DDI cache match for phone's iOS version
#   - Xcode + iproxy + CocoaPods install state
#   - Mac network: SSID, IP, captive portal, Apple/ngrok reachability
# Outputs the recommended pnpm command for current state.
#
# Usage:
#   bash scripts/dev-doctor.sh        # diagnose + recommend
#   bash scripts/dev-doctor.sh -y     # diagnose + auto-run recommendation
#   pnpm doctor                       # via package.json
# ──────────────────────────────────────────────────────────────────────────────

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

AUTO_RUN=false
[ "${1:-}" = "-y" ] && AUTO_RUN=true

BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
CYAN=$'\033[36m'
RESET=$'\033[0m'

ok()   { printf "  %s✓%s  %s\n" "$GREEN" "$RESET" "$1"; }
warn() { printf "  %s!%s  %s\n" "$YELLOW" "$RESET" "$1"; }
bad()  { printf "  %s✗%s  %s\n" "$RED" "$RESET" "$1"; }
note() { printf "  %s·%s  %s\n" "$DIM" "$RESET" "$1"; }

section() { printf "\n%s%s%s\n" "$BOLD" "$1" "$RESET"; }

echo "${BOLD}Niyah dev doctor${RESET}"

# State flags
HAS_PHONE=false
HAS_DDI=false
HAS_PODS=false
APPLE_OK=false
NGROK_OK=false
CAPTIVE=false
XCODE_OK=false
ON_IPHONE_HOTSPOT=false
PHONE_IOS=""
PHONE_ID=""
PHONE_MODEL=""
NET_IFACE=""
NET_IP=""
NET_SSID=""
USB_MAC_IP=""
USB_PHONE_IP=""

get_ssid() {
  local iface="$1"
  local out=""
  out=$(networksetup -getairportnetwork "$iface" 2>/dev/null | grep "Current Wi-Fi Network" | sed 's/.*: //')
  if [ -z "$out" ]; then
    out=$(ipconfig getsummary "$iface" 2>/dev/null | awk -F ' SSID : ' '/ SSID :/{print $2; exit}' | tr -d ' ')
  fi
  echo "$out"
}

# ── Phone (USB) ──────────────────────────────────────────────────────────────
section "Phone (USB)"

if ! command -v idevice_id >/dev/null 2>&1; then
  bad "libimobiledevice not installed → brew install libimobiledevice"
else
  PHONE_ID="$(idevice_id -l 2>/dev/null | head -1 || true)"
  if [ -n "$PHONE_ID" ]; then
    HAS_PHONE=true
    ok "iPhone connected ($PHONE_ID)"
    PHONE_IOS="$(ideviceinfo -k ProductVersion 2>/dev/null || true)"
    PHONE_MODEL="$(ideviceinfo -k ProductType 2>/dev/null || true)"
    if [ -n "$PHONE_IOS" ]; then
      note "iOS $PHONE_IOS · $PHONE_MODEL"
    else
      warn "Pairing not trusted — unlock phone, tap 'Trust This Computer'"
    fi
  else
    bad "No iPhone via USB. Plug in, unlock, tap 'Trust This Computer'."
  fi
fi

# ── Developer Disk Image ─────────────────────────────────────────────────────
section "Developer Disk Image"

if [ -n "$PHONE_IOS" ]; then
  DDI_DIR="$HOME/Library/Developer/Xcode/iOS DeviceSupport"
  if [ -d "$DDI_DIR" ]; then
    DDI_MATCH="$(ls "$DDI_DIR" 2>/dev/null | grep -E "(^| )${PHONE_IOS}( |\$|\()" | head -1)"
    if [ -n "$DDI_MATCH" ]; then
      HAS_DDI=true
      ok "DDI cached: $DDI_MATCH"
    else
      bad "No DDI for iOS $PHONE_IOS — first build needs clean network"
      note "Cached versions: $(ls "$DDI_DIR" 2>/dev/null | tr '\n' ' ')"
    fi
  else
    bad "DDI dir missing entirely — open Xcode, connect phone, wait"
  fi
else
  note "Skipped (phone iOS unknown)"
fi

# ── Xcode ────────────────────────────────────────────────────────────────────
section "Xcode"

if command -v xcodebuild >/dev/null 2>&1; then
  XCODE_VER="$(xcodebuild -version 2>/dev/null | head -1 | awk '{print $2}')"
  ok "Xcode $XCODE_VER"
  if [ -n "$PHONE_IOS" ]; then
    XC_MAJOR="${XCODE_VER%%.*}"
    PH_MAJOR="${PHONE_IOS%%.*}"
    if [ "${XC_MAJOR:-0}" -ge "${PH_MAJOR:-0}" ] 2>/dev/null; then
      XCODE_OK=true
      ok "Supports iOS $PHONE_IOS"
    else
      bad "Xcode $XCODE_VER too old for iOS $PHONE_IOS — update from App Store"
    fi
  else
    XCODE_OK=true
  fi
else
  bad "xcodebuild not found — install Xcode + Command Line Tools"
fi

# ── Mac network ──────────────────────────────────────────────────────────────
section "Mac network"

for iface in en0 en1 en2 en3 en4 en5 en6 en7 en8 en9 bridge100; do
  ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
  if [ -n "$ip" ]; then
    NET_IFACE="$iface"
    NET_IP="$ip"
    NET_SSID="$(get_ssid "$iface")"
    if echo "$ip" | grep -qE '^172\.20\.10\.'; then
      ON_IPHONE_HOTSPOT=true
      ok "$iface · iPhone hotspot · $ip"
    elif [ -n "$NET_SSID" ]; then
      ok "$iface · wifi: $NET_SSID · $ip"
    else
      ok "$iface · wired/unknown · $ip"
    fi
    break
  fi
done
[ -z "$NET_IP" ] && bad "No network interface with IP"

# USB-Ethernet detection. iOS exposes a link-local IPv4 stack on the cable
# (169.254.x.x). Phone routes that subnet via USB, so it works regardless of
# whichever wifi the phone happens to be on — bulletproof on public wifi.
USB_PHONE_IP="$(arp -a 2>/dev/null | awk '/iphone\.local|iPhone/ && /169\.254/{gsub(/[()]/,"",$2); print $2; exit}')"
if [ -n "$USB_PHONE_IP" ]; then
  USB_IFACE="$(arp -a 2>/dev/null | awk -v ip="$USB_PHONE_IP" '$0 ~ ip {for (i=1;i<=NF;i++) if ($i=="on") print $(i+1)}' | head -1)"
  [ -n "$USB_IFACE" ] && USB_MAC_IP="$(ipconfig getifaddr "$USB_IFACE" 2>/dev/null || true)"
  if [ -n "$USB_MAC_IP" ]; then
    ok "USB-Ethernet: Mac $USB_MAC_IP ↔ phone $USB_PHONE_IP (cable bypass available)"
  fi
fi

# Captive portal probe — Apple's hotspot detector returns "Success" if open
CAPTIVE_BODY="$(curl -s --max-time 3 http://captive.apple.com/hotspot-detect.html 2>/dev/null || true)"
if echo "$CAPTIVE_BODY" | grep -q "Success"; then
  ok "No captive portal"
else
  CAPTIVE=true
  bad "Captive portal detected — open browser, accept terms"
fi

# Endpoint reachability. curl prints "000" via %{http_code} on connect failure
# AND exits non-zero — guard the fallback so we don't double-print.
probe() {
  local url="$1" code
  code="$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "$url" 2>/dev/null)" || true
  echo "${code:-000}"
}

APPLE_HTTP="$(probe https://developer.apple.com)"
case "$APPLE_HTTP" in
  2*|3*) APPLE_OK=true; ok "Apple dev endpoint reachable" ;;
  *) warn "Apple dev endpoint blocked (HTTP $APPLE_HTTP) — DDI downloads will fail" ;;
esac

# Probe an ngrok tunnel-agent endpoint, not their marketing site. Public-wifi DPI
# often lets ngrok.com through but kills the actual tunnel handshake — checking
# the agent endpoint catches that closer to reality.
NGROK_HTTP="$(probe https://connect.us.ngrok-agent.com)"
case "$NGROK_HTTP" in
  2*|3*|4*) NGROK_OK=true; ok "Ngrok agent endpoint reachable" ;;
  *) warn "Ngrok agent endpoint blocked (HTTP $NGROK_HTTP) — \`--tunnel\` mode will fail" ;;
esac

# ── CocoaPods ────────────────────────────────────────────────────────────────
section "CocoaPods"

if [ -d ios/Pods ] && [ -f ios/Podfile.lock ]; then
  HAS_PODS=true
  ok "ios/Pods installed"
else
  bad "ios/Pods missing → cd ios && pod install"
fi

# ── Recommendation ───────────────────────────────────────────────────────────
section "Recommendation"

REC_CMD=""
REC_MSG=""

if [ "$CAPTIVE" = true ]; then
  REC_MSG="Open browser, accept captive portal terms. Re-run doctor."
elif [ "$HAS_PHONE" = false ]; then
  REC_MSG="Plug iPhone in via USB, unlock, trust Mac. Re-run doctor."
elif [ "$XCODE_OK" = false ]; then
  REC_MSG="Update Xcode from Mac App Store, then re-run doctor."
elif [ "$HAS_PODS" = false ]; then
  REC_CMD="cd ios && pod install && cd .."
  REC_MSG="Install CocoaPods deps."
elif [ "$HAS_DDI" = false ] && [ "$APPLE_OK" = false ]; then
  REC_MSG="DDI missing for iOS $PHONE_IOS AND Apple endpoints blocked. Switch to iPhone hotspot or trusted wifi, then: pnpm build:local"
elif [ "$HAS_DDI" = false ]; then
  REC_MSG="DDI missing for iOS $PHONE_IOS. Open Xcode → Window → Devices and Simulators. Wait for 'Preparing iPhone for development' (~5-20 min). Then: pnpm build:local"
elif [ "$ON_IPHONE_HOTSPOT" = true ]; then
  REC_CMD="pnpm start"
  REC_MSG="On iPhone hotspot — Mac + phone share NAT, LAN discovery works. Run pnpm build:local first if native code changed."
else
  REC_CMD="pnpm start"
  REC_MSG="Metro on Mac at $NET_IP:8081. Phone must be on the SAME wifi (or share an iPhone hotspot)."
  if [ -n "$USB_MAC_IP" ]; then
    REC_MSG="$REC_MSG If wifi has client isolation (common on public/campus): on phone, shake → 'Enter URL manually' → http://$USB_MAC_IP:8081 (routes over USB cable, wifi-independent)."
  else
    REC_MSG="$REC_MSG If auto-discovery fails: shake phone → 'Enter URL manually' → http://$NET_IP:8081."
  fi
  if [ "$NGROK_OK" = false ]; then
    REC_MSG="$REC_MSG Ngrok blocked here; --tunnel won't work."
  fi
fi

printf "  %s%s%s\n" "$CYAN" "$REC_MSG" "$RESET"
if [ -n "$REC_CMD" ]; then
  printf "\n  %s\$%s %s%s%s\n\n" "$BOLD" "$RESET" "$GREEN" "$REC_CMD" "$RESET"
else
  echo
fi

# ── Auto-run ─────────────────────────────────────────────────────────────────
if [ "$AUTO_RUN" = true ] && [ -n "$REC_CMD" ]; then
  echo "${DIM}Running: $REC_CMD${RESET}"
  eval "$REC_CMD"
fi
