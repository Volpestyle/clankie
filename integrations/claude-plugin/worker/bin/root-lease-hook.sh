#!/bin/sh
# This hint only saves work. The service still proves the exact native session.
case ${HERDR_PANE_ID-} in ''|*[!a-zA-Z0-9:_-]*) exit 0 ;; esac
case /${HERDR_SOCKET_PATH-}/ in //|*/../*) exit 0 ;; esac
hint="${CLANKIE_STATE:-${HOME}/.clankie}/fleet-resources/root-hook-leases/${HERDR_SOCKET_PATH}/${HERDR_PANE_ID}"
[ -f "$hint" ] || exit 0
# Claim atomically; restore on every outcome except a confirmed absent lease.
claim="${hint}.claim.$$"
mv -f -- "$hint" "$claim" 2>/dev/null || exit 0
restore() {
  [ -f "$claim" ] || return 0
  # Never overwrite a hint already re-armed by the service or another hook.
  ln "$claim" "$hint" 2>/dev/null || :
  rm -f -- "$claim"
}
trap restore 0
trap 'exit 0' 1 2 15
export CLANKIE_ROOT_HOOK_CLAIM="$claim"
node "${CLAUDE_PLUGIN_ROOT}/bin/seat-hook.mjs"
