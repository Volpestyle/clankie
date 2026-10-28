#!/bin/sh
# This hint only saves work. The service still proves the exact native session.
case ${HERDR_PANE_ID-} in ''|*[!a-zA-Z0-9:_-]*) exit 0 ;; esac
case /${HERDR_SOCKET_PATH-}/ in //|*/../*) exit 0 ;; esac
hint="${CLANKIE_STATE:-${HOME}/.clankie}/fleet-resources/root-hook-leases/${HERDR_SOCKET_PATH}/${HERDR_PANE_ID}"
[ -f "$hint" ] || exit 0
# Consume before reporting: an orphaned hint costs one helper, never a loop.
# A successful lease update writes it again. Failure only loses finite renewal.
claim="${hint}.claim.$$"
mv -f -- "$hint" "$claim" 2>/dev/null || exit 0
rm -f -- "$claim" || exit 0
exec node "${CLAUDE_PLUGIN_ROOT}/bin/seat-hook.mjs"
