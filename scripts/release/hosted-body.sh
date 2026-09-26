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

down() {
  trap - TERM INT
  clankie down >&2 || true
  exit 0
}
trap down TERM INT

healthy() {
  curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:4310/health &&
    curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:${CLANKIE_RELAY_PORT:-4321}/health"
}

clankie restart clankie >&2
while :; do
  # `wait` returns on a signal, so a stop never waits out the interval.
  sleep "$check_seconds" &
  wait $! || true
  healthy || clankie restart clankie >&2 || true
done
