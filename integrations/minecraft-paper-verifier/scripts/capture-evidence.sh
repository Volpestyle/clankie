#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PACKAGE="$ROOT/integrations/minecraft-paper-verifier"
OUT="$ROOT/artifacts/vuh-774/paper-verifier"

case "$OUT" in
  */artifacts/vuh-774/paper-verifier) rm -rf "$OUT" ;;
  *) echo "Refusing to replace unexpected evidence path: $OUT" >&2; exit 2 ;;
esac
mkdir -p "$OUT"
cp -R "$PACKAGE/build/scenario-evidence" "$OUT/scenario-evidence"
cp -R "$PACKAGE/build/test-results/test" "$OUT/junit"
cp "$PACKAGE/build/libs/clankie-paper-verifier-0.1.0.jar" "$OUT/"
cp "$ROOT/scenarios/minecraft/collect-craft-place/v1/scenario.sha256" "$OUT/fixture.sha256"
cp "$ROOT/scenarios/minecraft/collect-craft-place/v1/server.properties.sha256" "$OUT/server-config.sha256"
pnpm --dir "$PACKAGE" exec vitest run --reporter=json --outputFile="$OUT/contracts-test.json"
pnpm --dir "$PACKAGE" exec tsx "$PACKAGE/scripts/validate-evidence.ts" "$OUT"
(
  cd "$OUT"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS
)
