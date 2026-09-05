#!/usr/bin/env bash
# Exercises run-arm.sh's guards and its brief substitution. Starts no service,
# reads no credential, makes no model call, and creates nothing outside mktemp.
#
#   ./check-flow.sh
set -uo pipefail
FLOW_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN="$FLOW_DIR/run-arm.sh"
FREE_PORT=4410
pass=0 fail=0

# Asserts the command fails AND says why in the way a reader can act on.
refuses() {
  local label="$1" expect="$2"; shift 2
  local out status
  out=$("$@" 2>&1); status=$?
  if [ "$status" -eq 0 ]; then
    echo "  FAIL $label: expected a refusal, got exit 0"; fail=$((fail + 1)); return
  fi
  case "$out" in
    *"$expect"*) echo "  ok   $label"; pass=$((pass + 1)) ;;
    *) echo "  FAIL $label: wanted '$expect', got: $(echo "$out" | tail -1)"; fail=$((fail + 1)) ;;
  esac
}

accepts() {
  local label="$1" expect="$2"; shift 2
  local out status
  out=$("$@" 2>&1); status=$?
  if [ "$status" -ne 0 ]; then
    echo "  FAIL $label: expected success, got $status: $(echo "$out" | tail -1)"; fail=$((fail + 1)); return
  fi
  case "$out" in
    *"$expect"*) echo "  ok   $label"; pass=$((pass + 1)) ;;
    *) echo "  FAIL $label: wanted '$expect' in output"; fail=$((fail + 1)) ;;
  esac
}

NEW_ROOT="${TMPDIR:-/tmp}/cf-$$"          # never created: --check makes nothing
EXISTING=$(mktemp -d)
LONG_ROOT="/tmp/$(node -e 'process.stdout.write("x".repeat(70))')"

echo "== argument guards =="
refuses "unknown flag"        "unknown argument"                 "$RUN" --arm terra --root "$NEW_ROOT" --nope
refuses "missing arm"         "--arm must be terra or astra"     "$RUN" --root "$NEW_ROOT" --check
refuses "bad arm"             "--arm must be terra or astra"     "$RUN" --arm bogus --root "$NEW_ROOT" --check
refuses "missing root"        "--root DIR is required"           "$RUN" --arm terra --check
refuses "relative root"       "must be an absolute path"         "$RUN" --arm terra --root ./scratch --check
refuses "dot segment"         "must not contain . or .. segments" "$RUN" --arm terra --root /tmp/a/../b --check
refuses "single dot segment"  "must not contain . or .. segments" "$RUN" --arm terra --root /tmp/a/./b --check
refuses "existing root"       "must not already exist"           "$RUN" --arm terra --root "$EXISTING" --check
refuses "HOME as root"        "must not already exist"           "$RUN" --arm terra --root "$HOME" --check
refuses "root /"              "must not already exist"           "$RUN" --arm terra --root / --check
refuses "over-long root"      "too long for Herdr's sockets"     "$RUN" --arm terra --root "$LONG_ROOT" --check
refuses "non-numeric port"    "--port must be a whole number"    "$RUN" --arm terra --root "$NEW_ROOT" --port abc --check
refuses "privileged port"     "--port must be between"           "$RUN" --arm terra --root "$NEW_ROOT" --port 80 --check
refuses "port over range"     "--port must be between"           "$RUN" --arm terra --root "$NEW_ROOT" --port 70000 --check

echo "== prerequisites and substitution =="
accepts "terra --check"  "ok: driver self-check"  "$RUN" --arm terra --root "$NEW_ROOT" --port "$FREE_PORT" --check
accepts "astra --check"  "ok: brief substitution" "$RUN" --arm astra --root "$NEW_ROOT" --port "$FREE_PORT" --check
accepts "substitution names this run's worktree" "-> $NEW_ROOT/wt-terra" \
  "$RUN" --arm terra --root "$NEW_ROOT" --port "$FREE_PORT" --check

echo "== --check creates nothing =="
if [ -e "$NEW_ROOT" ]; then
  echo "  FAIL: --check created $NEW_ROOT"; fail=$((fail + 1))
else
  echo "  ok   no scratch root created"; pass=$((pass + 1))
fi

echo "== the archived briefs are unmodified by any of this =="
if git -C "$FLOW_DIR" status --porcelain -- "$FLOW_DIR/brief-terra.md" "$FLOW_DIR/brief-astra.md" \
   | grep -q .; then
  echo "  note: briefs differ from the index (expected while this archive is uncommitted)"
fi
for arm in terra astra; do
  if grep -q "/Users/james/.clankie-case-a/wt-$arm" "$FLOW_DIR/brief-$arm.md"; then
    echo "  ok   brief-$arm.md still carries the original run's path"; pass=$((pass + 1))
  else
    echo "  FAIL brief-$arm.md lost the original path"; fail=$((fail + 1))
  fi
done


echo "== the regression patch applies cleanly to a fresh baseline =="
PATCH_WT=$(mktemp -d)/wt
REPO=$(git -C "$FLOW_DIR" rev-parse --show-toplevel)
if git -C "$REPO" worktree add --detach "$PATCH_WT" a4353d43 >/dev/null 2>&1 \
   && git -C "$PATCH_WT" apply "$FLOW_DIR/regression-at-a4353d43.diff" >/dev/null 2>&1; then
  echo "  ok   git apply against a4353d43"; pass=$((pass + 1))
else
  echo "  FAIL regression patch does not apply to a4353d43"; fail=$((fail + 1))
fi
git -C "$REPO" worktree remove --force "$PATCH_WT" >/dev/null 2>&1
rmdir "$(dirname "$PATCH_WT")" 2>/dev/null

echo "== suite assertion accepts the real baseline reports =="
EV="$FLOW_DIR/../evidence"
REGRESSION="does not reuse action keys when the world replays an existing join"
judge() {
  local label="$1" expect="$2"; shift 2
  if node "$FLOW_DIR/assert-suite.mjs" "$@" >/dev/null 2>&1; then
    got=accept
  else
    got=reject
  fi
  if [ "$got" = "$expect" ]; then echo "  ok   $label"; pass=$((pass + 1));
  else echo "  FAIL $label: $got, wanted $expect"; fail=$((fail + 1)); fi
}
judge "real red report is the expected red"   accept "$EV/baseline-red.json"   red   31 "$REGRESSION"
judge "real green report is a clean pass"     accept "$EV/baseline-green.json" green 31 "$REGRESSION"

echo "== and rejects the shapes a bare exit code would pass =="
FAKES=$(mktemp -d)
node -e '
  const fs = require("node:fs"), dir = process.argv[1], real = process.argv[2];
  // A suite that collected nothing still exits 0 in vitest.
  fs.writeFileSync(`${dir}/empty.json`, JSON.stringify({ numTotalTests: 0, numFailedTests: 0, testResults: [] }));
  // A failure, but not the one the regression is supposed to cause.
  const report = JSON.parse(fs.readFileSync(real, "utf8"));
  for (const suite of report.testResults) {
    for (const a of suite.assertionResults) if (a.status === "failed") a.title = "some unrelated test";
  }
  fs.writeFileSync(`${dir}/wrong.json`, JSON.stringify(report));
' "$FAKES" "$EV/baseline-red.json"
judge "empty suite is not a red"              reject "$FAKES/empty.json"       red   31 "$REGRESSION"
judge "a different failing test is not a red" reject "$FAKES/wrong.json"       red   31 "$REGRESSION"
judge "a green suite is not a red"            reject "$EV/baseline-green.json" red   31 "$REGRESSION"
judge "a red suite is not a green"            reject "$EV/baseline-red.json"   green 31 "$REGRESSION"
judge "a missing report is not a green"       reject "$FAKES/absent.json"      green 31 "$REGRESSION"
rm -rf "$FAKES"

rmdir "$EXISTING" 2>/dev/null
echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
