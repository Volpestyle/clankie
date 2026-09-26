#!/bin/sh
# One owner's whole body in one container, under the launcher: it starts
# Clankie and everything that restarts with it, then this process stays in the
# foreground so the container lives exactly as long as the body. Run it with an
# init (`docker run --init`): the launcher's detached services are reparented
# to PID 1, which must reap them.
set -eu

# The image's loadout (CLANKIE_SERVICES) is idle-honest: only what a paired
# device reaches. Discord, activity and the tunnel keep a body awake without
# customer work.
check_seconds="${CLANKIE_BODY_CHECK_SECONDS:-30}"

# Metadata-only telemetry (packages/observability/src/body-telemetry.ts), off
# unless the host names a spool directory. Only fixed codes and numbers are
# written here; the host ships the spool, the body holds no credentials.
telemetry_dir="${CLANKIE_BODY_TELEMETRY_DIR:-}"
now_ms() {
  ms="$(date +%s%3N)"
  case "$ms" in *N) echo $(($(date +%s) * 1000)) ;; *) echo "$ms" ;; esac
}
started_ms="$(now_ms)"
restarts=0
emit() {
  [ -n "$telemetry_dir" ] || return 0
  mkdir -p "$telemetry_dir" 2>/dev/null &&
    printf '{"v":1,"atMs":%s,%s}\n' "$(now_ms)" "$1" \
      >>"$telemetry_dir/$(date -u +%Y%m%d%H)-body.jsonl" 2>/dev/null || true
}
since_start() { echo $(($(now_ms) - started_ms)); }

down() {
  trap - TERM INT
  emit '"event":"body.shutdown","reason":"sigterm"'
  clankie down >&2 || true
  exit 0
}
trap down TERM INT

healthy() {
  curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:4310/health &&
    curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:${CLANKIE_RELAY_PORT:-4321}/health"
}

emit '"event":"body.boot","phase":"container-start","sinceStartMs":0'
if clankie restart clankie >&2; then
  emit "\"event\":\"body.boot\",\"phase\":\"clankie-healthy\",\"sinceStartMs\":$(since_start)"
else
  emit '"event":"body.service","service":"clankie","state":"crashed","reason":"start-failed"'
  exit 1
fi
while :; do
  # `wait` returns on a signal, so a stop never waits out the interval.
  sleep "$check_seconds" &
  wait $! || true
  healthy && continue
  restarts=$((restarts + 1))
  emit "\"event\":\"body.service\",\"service\":\"clankie\",\"state\":\"restarting\",\"reason\":\"health-check-failed\",\"restarts\":$restarts"
  if clankie restart clankie >&2; then
    emit "\"event\":\"body.service\",\"service\":\"clankie\",\"state\":\"healthy\",\"restarts\":$restarts"
  else
    emit "\"event\":\"body.service\",\"service\":\"clankie\",\"state\":\"crashed\",\"reason\":\"restart-failed\",\"restarts\":$restarts"
  fi
done
