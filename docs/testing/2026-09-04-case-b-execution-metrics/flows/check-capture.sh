#!/usr/bin/env bash
# Exercise the flow's actual capture function without a service or model call.
set -euo pipefail
FLOW=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-arm.sh
eval "$(sed -n '/^capture_source() {$/,/^}$/p' "$FLOW")"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
WT="$ROOT/source"
ARM=fixture
CAPTURED=0
mkdir -p "$WT" "$ROOT/logs"
git -C "$WT" init -q
printf 'baseline\n' >"$WT/tracked.txt"
git -C "$WT" add .
git -C "$WT" -c user.name=Capture -c user.email=capture@example.test commit -qm baseline
BASELINE=$(git -C "$WT" rev-parse HEAD)
printf 'committed source\n' >"$WT/tracked.txt"
git -C "$WT" -c user.name=Capture -c user.email=capture@example.test commit -qam source
printf 'new source\n' >"$WT/new.ts"
printf '\000\001binary\377' >"$WT/new.bin"
mkdir -p "$WT/apps/demo/test"
printf 'test only\n' >"$WT/apps/demo/test/new.test.ts"
capture_source
[ "$CAPTURED" -eq 1 ]
git -C "$WT" worktree add -q --detach "$ROOT/full" "$BASELINE"
git -C "$ROOT/full" apply "$ROOT/logs/agent-fixture.diff"
cmp "$WT/tracked.txt" "$ROOT/full/tracked.txt"
cmp "$WT/new.ts" "$ROOT/full/new.ts"
cmp "$WT/new.bin" "$ROOT/full/new.bin"
cmp "$WT/apps/demo/test/new.test.ts" "$ROOT/full/apps/demo/test/new.test.ts"
git -C "$WT" worktree add -q --detach "$ROOT/verify" "$BASELINE"
git -C "$ROOT/verify" apply "$ROOT/logs/source-only-fixture.diff"
cmp "$WT/new.bin" "$ROOT/verify/new.bin"
[ ! -e "$ROOT/verify/apps/demo/test/new.test.ts" ]
CAPTURED=0
rm "$ROOT/logs/source-only-fixture.diff"
mkdir "$ROOT/logs/source-only-fixture.diff"
if capture_source 2>/dev/null; then
  echo 'failed capture reported success' >&2
  exit 1
fi
[ "$CAPTURED" -eq 0 ]
[ -f "$WT/new.ts" ]
echo 'capture: full recovery, source-only exclusion and failure retention passed'
