#!/usr/bin/env bash
# Replays the real-boundary verification. Read-only: it writes nothing into
# either repository and removes its temporary databases even on failure.
#
#   CLANKIE_APP_ROOT=/path/to/clankie-app flows/run.sh
#
set -euo pipefail
flows="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${flows}/../../../.." && pwd)"
app="${CLANKIE_APP_ROOT:-$(cd "${repo}/.." && pwd)/clankie-app}"

# Provenance, so a result is always attributable. No tokens, keys or owner state.
printf 'clankie   %s%s\n' \
  "$(git -C "${repo}" rev-parse --short HEAD)" \
  "$(git -C "${repo}" diff --quiet -- apps/gateway/src packages/protocol/src || printf ' (gateway/protocol sources dirty)')"
printf 'clankie-app %s%s\n' \
  "$(git -C "${app}" rev-parse --short HEAD)" \
  "$(test -z "$(git -C "${app}" status --porcelain -- apps/mobile/pushDelivery.ts)" || printf ' (pushDelivery.ts dirty)')"
printf 'app root  %s\n\n' "${app}"

cd "${repo}"
exec pnpm exec vitest run --config "${flows}/vitest.boundary.config.mjs" "$@"
