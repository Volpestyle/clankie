#!/usr/bin/env bash
#
# ios-device.sh — build + run @sapling/mobile on a physical iOS device over Tailscale.
# Adapted from clankies apps/mobile/scripts/ios-device.sh.
#
# Why this exists: `expo run:ios` targets the *simulator*, and a plain
# `expo run:ios --device` starts Metro bound to the Mac's LAN IP — which a
# tailnet-only iOS device can't reach, so the app loads the JS bundle then hangs
# on the splash while asset fetches time out. This script hosts Metro on the
# Mac's MagicDNS name (bundle *and* assets → reachable over the tailnet),
# builds/installs the dev client on the device, and launches it pointed at that
# Metro.
#
# Usage:  pnpm ios:device [<target>]      (auto-detects the one connected iOS device)
#           <target> = hardware UDID · CoreDevice UUID · exact device name ·
#           a comma-separated list of those · or "all" for every connected device.
# Env:    CLANKIE_METRO_PORT (default 8082 — the mobile lane; macOS lane owns 8081)
#         CLANKIE_IOS_DEVICE (same as <target>)
#         CLANKIE_IOS_DEVELOPMENT_TEAM (optional; defaults to the sole Xcode account/cert team)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

# This script builds the dev-client variant (see app.config.js). Force the
# variant so every child expo command (prebuild below, Metro start) resolves the
# dev identity even when the script is invoked directly rather than via
# `pnpm ios:device`.
export CLANKIE_VARIANT="${CLANKIE_VARIANT:-dev}"

PORT="${CLANKIE_METRO_PORT:-8082}"
BUNDLE_ID="io.clankie.v2.dev"
SCHEME="Sapling"

log()  { printf '\033[1;36m[ios:device]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ios:device] %s\033[0m\n' "$*" >&2; exit 1; }
urlencode() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }

sole_team() {
  local teams="$1"
  local team_count
  team_count="$(printf '%s\n' "$teams" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$team_count" = "1" ]; then
    printf '%s\n' "$teams" | sed '/^$/d' | head -n 1
    return 0
  fi
  return 1
}

detect_xcode_account_team() {
  local teams
  teams="$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null \
    | sed -nE 's/^[[:space:]]*teamID = ([A-Z0-9]{10});/\1/p' \
    | sort -u)"

  sole_team "$teams"
}

detect_certificate_team() {
  local teams
  teams="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -nE 's/^[[:space:]]*[0-9]+\) [A-Fa-f0-9]+ "Apple Development: .*\(([A-Z0-9]{10})\)"$/\1/p' \
    | sort -u)"

  sole_team "$teams"
}

detect_development_team() {
  detect_xcode_account_team || detect_certificate_team
}

# -- 1. Advertised Metro host: MagicDNS name, else LAN IP -----------------------
tailscale_bin() { command -v tailscale 2>/dev/null || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale; }
HOST_ADV="$("$(tailscale_bin)" status --json 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
if [ -z "${HOST_ADV:-}" ]; then
  HOST_ADV="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  [ -n "$HOST_ADV" ] || die "Could not resolve a MagicDNS name or LAN IP for Metro."
  log "Tailscale not found — falling back to LAN IP $HOST_ADV (fails if the device is tailnet-only)."
fi
METRO_URL="http://${HOST_ADV}:${PORT}"
log "Metro host: $METRO_URL"

# -- 2. Ensure Metro is up on $PORT advertising $HOST_ADV -----------------------
# Reuse a running Metro only if it is OURS: a stale dev server from another
# project (e.g. a spike scratchpad) answers /status just as happily and the
# phone would silently load the wrong bundle. The listener's cwd is the test.
metro_owner_cwd() {
  local pid
  pid="$(lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1)"
  [ -n "$pid" ] || return 1
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

if curl -sf -m 3 "http://127.0.0.1:${PORT}/status" >/dev/null 2>&1; then
  OWNER_CWD="$(metro_owner_cwd || true)"
  if [ "$OWNER_CWD" != "$APP_DIR" ]; then
    die "Port $PORT is served by a foreign dev server (cwd: ${OWNER_CWD:-unknown}). Kill it or set CLANKIE_METRO_PORT to a free port."
  fi
  log "Metro already running on :$PORT from $APP_DIR — reusing (it must advertise $HOST_ADV)."
else
  command -v screen >/dev/null || die "screen not found (needed to host a persistent Metro)."
  log "Starting Metro in 'screen -S sapling-metro' advertising $HOST_ADV …"
  screen -S sapling-metro -X quit 2>/dev/null || true
  screen -dmS sapling-metro bash -lc \
    "cd '$APP_DIR' && REACT_NATIVE_PACKAGER_HOSTNAME='$HOST_ADV' EXPO_NO_TELEMETRY=1 pnpm exec expo start --dev-client --port ${PORT}"
  for _ in $(seq 1 30); do curl -sf -m 2 "http://127.0.0.1:${PORT}/status" >/dev/null 2>&1 && break; sleep 1; done
  curl -sf -m 3 "http://127.0.0.1:${PORT}/status" >/dev/null 2>&1 || die "Metro failed to start on :$PORT."
  log "Metro up (logs: screen -r sapling-metro)."
fi

# -- 3. Resolve the connected iOS device ----------------------------------------
# expo run:ios wants the hardware UDID; devicectl launch wants the CoreDevice
# UUID. CoreDevice's JSON output is stable enough to map both for iPhone and iPad.
DEVICE_QUERY="${1:-${CLANKIE_IOS_DEVICE:-}}"
DEVICE_JSON="$(mktemp -t sapling-ios-devices.XXXXXX.json)"
DEVICE_ERROR="$(mktemp -t sapling-ios-device-error.XXXXXX.txt)"
trap 'rm -f "$DEVICE_JSON" "$DEVICE_ERROR"' EXIT

list_devices() {
  xcrun devicectl list devices --json-output "$DEVICE_JSON" --quiet >/dev/null
}

select_devices() {
  python3 - "$DEVICE_JSON" "${DEVICE_QUERY:-}" <<'PY'
import json
import sys

path = sys.argv[1]
query = sys.argv[2].strip().casefold()

with open(path, "r", encoding="utf-8") as handle:
    devices = json.load(handle).get("result", {}).get("devices", [])

rows = []
for device in devices:
    hardware = device.get("hardwareProperties", {})
    connection = device.get("connectionProperties", {})
    properties = device.get("deviceProperties", {})
    if hardware.get("platform") != "iOS" or hardware.get("reality") != "physical":
        continue

    row = {
        "core": device.get("identifier", ""),
        "hw": hardware.get("udid", ""),
        "name": properties.get("name", ""),
        "type": hardware.get("deviceType", "iOS device"),
        "state": connection.get("tunnelState", "unknown"),
        "pairing": connection.get("pairingState", "unknown"),
        "transport": connection.get("transportType", "unknown"),
    }
    rows.append(row)

def label(row):
    return (
        f"{row['name']} ({row['type']}) hw={row['hw']} core={row['core']} "
        f"state={row['state']} pairing={row['pairing']} transport={row['transport']}"
    )

def emit(selected):
    for row in selected:
        print("\t".join([row["hw"], row["core"], row["name"], row["type"]]))

def match(token):
    return [
        row for row in rows
        if token in {row["hw"].casefold(), row["core"].casefold(), row["name"].casefold()}
    ]

connected = [row for row in rows if row["state"] == "connected"]

# "all"/"*" → every connected device; a comma-list → each named target (order
# preserved, de-duplicated); a single token → one device; empty → the sole
# connected device, erroring if the choice is ambiguous.
if query in {"all", "*"}:
    if not connected:
        print("No connected physical iOS devices found.", file=sys.stderr)
        for row in rows:
            print(f"  {label(row)}", file=sys.stderr)
        sys.exit(4)
    emit(connected)
elif query:
    chosen = []
    seen = set()
    for token in [t.strip() for t in query.split(",") if t.strip()]:
        matches = match(token)
        if not matches:
            print(f"No physical iOS device matched the requested target: {token}", file=sys.stderr)
            for row in rows:
                print(f"  {label(row)}", file=sys.stderr)
            sys.exit(2)
        picked = matches[0]
        if picked["state"] != "connected":
            print(f"Matched device is not connected: {label(picked)}", file=sys.stderr)
            print("Plug in, unlock, and trust this Mac before retrying.", file=sys.stderr)
            sys.exit(3)
        if picked["core"] not in seen:
            seen.add(picked["core"])
            chosen.append(picked)
    emit(chosen)
else:
    if not connected:
        print("No connected physical iOS devices found.", file=sys.stderr)
        for row in rows:
            print(f"  {label(row)}", file=sys.stderr)
        sys.exit(4)
    if len(connected) > 1:
        print("Multiple connected physical iOS devices found. Pass a hardware UDID, a comma-separated list, or CLANKIE_IOS_DEVICE=all:", file=sys.stderr)
        for row in connected:
            print(f"  {label(row)}", file=sys.stderr)
        sys.exit(5)
    emit(connected)
PY
}

wakeable_devices() {
  python3 - "$DEVICE_JSON" "${DEVICE_QUERY:-}" <<'PY'
import json
import sys

path = sys.argv[1]
query = sys.argv[2].strip().casefold()

tokens = None
if query and query not in {"all", "*"}:
    tokens = [t.strip() for t in query.split(",") if t.strip()]

with open(path, "r", encoding="utf-8") as handle:
    devices = json.load(handle).get("result", {}).get("devices", [])

for device in devices:
    hardware = device.get("hardwareProperties", {})
    connection = device.get("connectionProperties", {})
    properties = device.get("deviceProperties", {})
    if hardware.get("platform") != "iOS" or hardware.get("reality") != "physical":
        continue
    if connection.get("pairingState") != "paired" or connection.get("tunnelState") == "connected":
        continue

    core = device.get("identifier", "")
    hw = hardware.get("udid", "")
    name = properties.get("name", "")
    if tokens is not None and not any(
        t in {hw.casefold(), core.casefold(), name.casefold()} for t in tokens
    ):
        continue
    if core:
        print(core)
PY
}

list_devices
if ! DEVICE_LINES="$(select_devices 2>"$DEVICE_ERROR")"; then
  WAKE_CORES="$(wakeable_devices)"
  if [ -n "$WAKE_CORES" ]; then
    log "Waking CoreDevice tunnel for paired local-network device(s)…"
    while IFS= read -r CORE_ID_TO_WAKE; do
      [ -n "$CORE_ID_TO_WAKE" ] || continue
      xcrun devicectl device info details --device "$CORE_ID_TO_WAKE" >/dev/null 2>&1 || true
    done <<EOF
$WAKE_CORES
EOF
    list_devices
  fi

  if ! DEVICE_LINES="$(select_devices 2>"$DEVICE_ERROR")"; then
    cat "$DEVICE_ERROR" >&2
    exit 1
  fi
fi

TARGET_COUNT="$(printf '%s\n' "$DEVICE_LINES" | sed '/^$/d' | wc -l | tr -d ' ')"
log "Target device(s): $TARGET_COUNT"

# -- 4. Prebuild + signing team (resolved once for all targets) -----------------
# Regenerate when the workspace is missing OR the generated project's bundle id
# doesn't match the dev variant — e.g. after a standalone prebuild left the
# canonical io.clankie.v2 in ios/. --clean fully re-derives it from app.config.js.
if [ ! -d "ios/${SCHEME}.xcworkspace" ]; then
  log "Native iOS workspace missing; running Expo prebuild first."
  pnpm exec expo prebuild --platform ios
elif ! grep -q "io\.clankie\.v2\.dev" "ios/${SCHEME}.xcodeproj/project.pbxproj" 2>/dev/null; then
  log "Generated iOS project isn't the dev variant ($BUNDLE_ID); regenerating with prebuild --clean."
  pnpm exec expo prebuild --platform ios --clean
fi

DEVELOPMENT_TEAM="${CLANKIE_IOS_DEVELOPMENT_TEAM:-$(detect_development_team)}"
if [ -z "$DEVELOPMENT_TEAM" ]; then
  die "Could not infer a signing team. Set CLANKIE_IOS_DEVELOPMENT_TEAM to your Apple Developer Team ID."
fi
log "Signing team: $DEVELOPMENT_TEAM"

XCODE_SIGNING_ARGS=(
  "-allowProvisioningUpdates"
  "DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM"
)

# -- 5. Build + install + launch, once per target device ------------------------
# Build per device (not just once) so -allowProvisioningUpdates registers each
# device and refreshes the development profile before install. After the first
# device the builds are incremental, so extra devices cost little.
DEV_CLIENT_URL="sapling://expo-development-client/?url=$(urlencode "$METRO_URL")"
LAUNCH_WARNED=0
while IFS=$'\t' read -r HW_UDID CORE_ID DEVICE_NAME DEVICE_TYPE; do
  [ -n "$HW_UDID" ] || continue
  log "── $DEVICE_NAME ($DEVICE_TYPE) — hw=$HW_UDID core=$CORE_ID ──"
  log "Unlock and keep this device awake. Building signed app (a few minutes on first run)…"

  xcodebuild \
    -quiet \
    -workspace "ios/${SCHEME}.xcworkspace" \
    -scheme "$SCHEME" \
    -configuration Debug \
    -destination "id=$HW_UDID" \
    "${XCODE_SIGNING_ARGS[@]}" \
    build

  APP_PATH="$(xcodebuild \
    -showBuildSettings \
    -workspace "ios/${SCHEME}.xcworkspace" \
    -scheme "$SCHEME" \
    -configuration Debug \
    -destination "id=$HW_UDID" \
    "${XCODE_SIGNING_ARGS[@]}" 2>/dev/null \
    | awk -F' = ' '/^[[:space:]]*CODESIGNING_FOLDER_PATH = / { print $2; exit }')"
  [ -n "$APP_PATH" ] && [ -d "$APP_PATH" ] || die "Could not resolve built ${SCHEME}.app path after xcodebuild ($DEVICE_NAME)."

  log "Installing $APP_PATH on $DEVICE_NAME via devicectl…"
  xcrun devicectl device install app --device "$CORE_ID" "$APP_PATH"

  log "Launching the dev client at $METRO_URL on $DEVICE_NAME (device must be unlocked)…"
  if ! xcrun devicectl device process launch --terminate-existing \
        --device "$CORE_ID" --payload-url "$DEV_CLIENT_URL" "$BUNDLE_ID"; then
    log "Auto-launch failed on $DEVICE_NAME (device locked?). Open Sapling Dev → dev launcher → enter: $METRO_URL"
    LAUNCH_WARNED=1
  fi
done <<EOF
$DEVICE_LINES
EOF

if [ "$LAUNCH_WARNED" = "1" ]; then
  log "One or more devices didn't auto-launch — unlock them and reopen Sapling Dev pointed at $METRO_URL."
fi
log "Done. Reload JS from the Metro pane (screen -r sapling-metro) with 'r'."
