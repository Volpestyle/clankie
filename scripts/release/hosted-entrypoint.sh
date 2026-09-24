#!/bin/sh
set -eu
umask 077
# Only the default captain command initializes an absent workdir preference.
# CLI/relay overrides must not rewrite owner configuration.
if [ "$#" -eq 2 ] && [ "$2" = /opt/clankie/apps/clankie/src/index.js ]; then
  workdir=$(clankie workdir status)
  configured=$(printf '%s' "$workdir" | node -pe 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).workingDirectory !== null')
  if [ "$configured" = false ]; then
    clankie workdir set /workspace >/dev/null
  fi
fi
exec "$@"
