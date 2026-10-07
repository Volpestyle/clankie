#!/bin/sh
set -eu
umask 077
# The whole body reconciles its release root before anything runs from it.
# Side jobs (telemetry, one-off CLI) run the image read-only without /state.
if [ "$#" -eq 1 ] && [ "$1" = clankie-body ]; then
  clankie-release-root
fi
# Only the default captain command and the whole-body command initialize an
# absent workdir preference. CLI/relay overrides must not rewrite owner configuration.
if { [ "$#" -eq 2 ] && [ "$2" = /opt/clankie/apps/clankie/src/index.js ]; } ||
  { [ "$#" -eq 1 ] && [ "$1" = clankie-body ]; }; then
  workdir=$(clankie workdir status)
  configured=$(printf '%s' "$workdir" | node -pe 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).workingDirectory !== null')
  if [ "$configured" = false ]; then
    clankie workdir set /workspace >/dev/null
  fi
fi
exec "$@"
