#!/bin/sh
# A hired worker pane's shell (VUH-2592). Herdr starts this as the pane's SHELL;
# it starts the owner's login shell under the worker Seatbelt profile, so the
# harness, its tools and its MCP bridges inherit the profile. Without a profile
# it refuses rather than start an unconfined worker.
shell=${CLANKIE_WORKER_SHELL:-/bin/zsh}
profile=$CLANKIE_WORKER_SANDBOX_PROFILE
if [ -z "$profile" ]; then
  echo "clankie: no worker sandbox profile; refusing to start this pane unconfined" >&2
  exit 78
fi
# Children that start $SHELL get the real shell, never this wrapper again.
export SHELL="$shell"
exec /usr/bin/sandbox-exec -p "$profile" "$shell" -l
