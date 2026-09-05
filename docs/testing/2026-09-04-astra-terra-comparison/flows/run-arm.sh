#!/usr/bin/env bash
# One case-A arm, end to end, against an isolated second service.
#
#   ./run-arm.sh --arm terra|astra --root DIR [--port N] [--check]
#
# --root must be a NEW absolute directory. Each arm needs its own: reusing a
# root would carry the previous arm's config and state into this one, and the
# teardown here deletes only what it created.
#
# --check validates every prerequisite (tooling, bundled Herdr, the baseline
# commits, the brief and its path substitution, free ports, the driver's own
# wiring) and exits. It starts no service, reads no credential, makes no model
# call and creates nothing.
#
# The owner's ~/.config/clankie, live service and Herdr fleet are never written:
# every clankie command runs under the isolated XDG roots this script creates,
# and teardown touches only the service process group it started, the agents on
# its own private Herdr socket, and its own two worktrees.
set -euo pipefail

BASELINE=a4353d43
# The regression as a patch against BASELINE, not as the fix commit's own diff:
# the file drifted between 8bbf18ee and here, so the commit diff neither applies
# cleanly nor three-way-merges into anything usable.
REGRESSION_PATCH_NAME=regression-at-a4353d43.diff
SUBJECT=apps/clankie/src/world/body.ts
CHECK_TEST=apps/clankie/test/world-body.test.ts
# The one failure the injected regression must produce, and the file's full size
# at BASELINE. A red run that fails for any other reason — a broken import, a
# renamed test, zero collected tests — is a broken harness, not evidence.
REGRESSION_TEST="does not reuse action keys when the world replays an existing join"
EXPECTED_TESTS=31
# The worktree path baked into the archived briefs, replaced per run.
ARCHIVED_WT_ROOT=/Users/james/.clankie-case-a

FLOW_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$FLOW_DIR" rev-parse --show-toplevel)
TSX="$REPO/node_modules/.bin/tsx"

die() { echo "$*" >&2; exit 2; }

ARM="" ROOT="" PORT=4410 CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --arm) ARM="${2:-}"; shift 2 ;;
    --root) ROOT="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$ARM" in
  terra) MODEL=openai-codex/gpt-5.6-terra ;;
  astra) MODEL=openai-codex/gpt-6-astra ;;
  *) die "--arm must be terra or astra" ;;
esac

# A root that already exists is refused outright. That covers / and $HOME, and
# it also refuses reuse between arms, which would carry config and state over.
[ -n "$ROOT" ] || die "--root DIR is required (a new absolute scratch directory)"
case "$ROOT" in
  /*) ;;
  *) die "--root must be an absolute path: $ROOT" ;;
esac
case "$ROOT" in
  */./*|*/../*|*/..|*/.) die "--root must not contain . or .. segments: $ROOT" ;;
esac
[ ! -e "$ROOT" ] && [ ! -L "$ROOT" ] || die "--root must not already exist (each arm needs a fresh one): $ROOT"
# Herdr's Unix sockets cap at 103 bytes and the runtime appends
# /herdr/herdr-client.sock, so a deep scratch path fails at service boot.
[ "${#ROOT}" -le 60 ] || die "--root is too long for Herdr's sockets: ${#ROOT} > 60"

# Validate the port before any arithmetic on it.
case "$PORT" in
  ''|*[!0-9]*) die "--port must be a whole number: $PORT" ;;
esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65524 ] || die "--port must be between 1024 and 65524: $PORT"
PORT=$((10#$PORT))
RELAY_PORT=$((PORT + 11))

ARCHIVED_BRIEF="$FLOW_DIR/brief-$ARM.md"
WT="$ROOT/wt-$ARM"
VERIFY="$ROOT/verify-$ARM"
STALE_WT="$ARCHIVED_WT_ROOT/wt-$ARM"

# The archived brief is the artifact of the original run and stays byte-exact;
# the run-local copy is the only thing ever sent, with the worktree path
# rewritten to this run's. Sending the archived one would point the agent at a
# directory that does not exist here.
render_brief() {
  node -e '
    const [src, dest, stale, actual] = process.argv.slice(1);
    const fs = require("node:fs");
    const original = fs.readFileSync(src, "utf8");
    if (!original.includes(stale)) throw new Error(`archived brief does not mention ${stale}`);
    const rendered = original.split(stale).join(actual);
    if (rendered.includes(stale)) throw new Error(`stale path survived substitution: ${stale}`);
    if (!rendered.includes(actual)) throw new Error(`run worktree path missing: ${actual}`);
    fs.writeFileSync(dest, rendered);
  ' "$1" "$2" "$3" "$4"
}

port_free() { ! nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }
fail=0
need() { command -v "$1" >/dev/null 2>&1 || { echo "  MISSING tool: $1" >&2; fail=1; }; }
echo "== prerequisites =="
need git; need node; need pnpm; need nc; need curl
[ -x "$REPO/.data/herdr/bin/herdr" ] || { echo "  MISSING bundled Herdr: run 'pnpm herdr:build'" >&2; fail=1; }
[ -x "$TSX" ] || { echo "  MISSING tsx: run 'pnpm install'" >&2; fail=1; }
git -C "$REPO" cat-file -e "$BASELINE^{commit}" 2>/dev/null || { echo "  MISSING baseline $BASELINE" >&2; fail=1; }
[ -f "$FLOW_DIR/$REGRESSION_PATCH_NAME" ] || { echo "  MISSING regression patch: $FLOW_DIR/$REGRESSION_PATCH_NAME" >&2; fail=1; }
[ -f "$ARCHIVED_BRIEF" ] || { echo "  MISSING brief: $ARCHIVED_BRIEF" >&2; fail=1; }
port_free "$PORT" || { echo "  PORT $PORT is in use" >&2; fail=1; }
port_free "$RELAY_PORT" || { echo "  PORT $RELAY_PORT is in use" >&2; fail=1; }
[ "$fail" -eq 0 ] || exit 1
echo "  ok: arm=$ARM model=$MODEL port=$PORT relay=$RELAY_PORT root=$ROOT"

# Prove the substitution the real run depends on, without creating the root.
PROBE=$(mktemp)
render_brief "$ARCHIVED_BRIEF" "$PROBE" "$STALE_WT" "$WT"
rm -f "$PROBE"
echo "  ok: brief substitution ($STALE_WT -> $WT)"
"$TSX" "$REPO/apps/clankie/scripts/comparison-run.ts" \
  --base "http://127.0.0.1:$PORT" --brief "$ARCHIVED_BRIEF" --check >/dev/null
echo "  ok: driver self-check"
if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "check only; nothing started"
  exit 0
fi

RESULT=0
SERVICE_PGID=""
HERDR_SOCK="$ROOT/state/herdr/herdr.sock"
teardown() {
  status=$?
  set +e
  # Agents the arm spawned live on this run's private Herdr socket only.
  if [ -S "$HERDR_SOCK" ]; then
    HERDR_SOCKET_PATH="$HERDR_SOCK" "$REPO/.data/herdr/bin/herdr" agent list 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
          for (const a of (JSON.parse(s).result?.agents ?? [])) console.log(a.pane_id);
        }catch{}})' \
      | while read -r pane; do
          HERDR_SOCKET_PATH="$HERDR_SOCK" "$REPO/.data/herdr/bin/herdr" pane close "$pane" >/dev/null 2>&1
        done
  fi
  # Only the process group this script started. No argv matching: a regex over
  # process arguments can match a bystander, and this runs beside the owner's
  # own service.
  if [ -n "$SERVICE_PGID" ]; then
    kill -TERM -"$SERVICE_PGID" 2>/dev/null
    sleep 4
    kill -KILL -"$SERVICE_PGID" 2>/dev/null
  fi
  git -C "$REPO" worktree remove --force "$WT" 2>/dev/null
  git -C "$REPO" worktree remove --force "$VERIFY" 2>/dev/null
  echo "teardown: service group stopped, private-Herdr agents closed, worktrees removed"
  echo "evidence kept: $ROOT/logs"
  exit "$status"
}
trap teardown EXIT

mkdir -p "$ROOT/config" "$ROOT/state" "$ROOT/cache" "$ROOT/logs"
chmod 700 "$ROOT/state"
export XDG_CONFIG_HOME="$ROOT/config" XDG_STATE_HOME="$ROOT/state" XDG_CACHE_HOME="$ROOT/cache"
export CLANKIE_STATE="$ROOT/state" PORT="$PORT" CLANKIE_RELAY_PORT="$RELAY_PORT"
# Test bearers, minted here and never echoed. Without these the isolated service
# would mint into — and read from — the owner's Keychain.
CLANKIE_OPERATOR_TOKEN=$(node -e 'process.stdout.write("clankie_op_"+require("node:crypto").randomBytes(32).toString("base64url"))')
CLANKIE_CAPTAIN_TOKEN=$(node -e 'process.stdout.write("clankie_cap_"+require("node:crypto").randomBytes(32).toString("base64url"))')
export CLANKIE_OPERATOR_TOKEN CLANKIE_CAPTAIN_TOKEN
# A service launched from inside a Herdr pane inherits HERDR_ENV=1, and
# resolveHerdrBinding reads that as "attach to the ambient session" — which is
# the operator's fleet, however isolated the config is. Scrub every HERDR_*.
for name in $(env | sed -n 's/^\(HERDR_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done
unset HERD_LEAD_SUMMARIES_CACHE

BRIEF="$ROOT/brief-$ARM.md"
render_brief "$ARCHIVED_BRIEF" "$BRIEF" "$STALE_WT" "$WT"

# Exactly one named failure, over the full expected suite. Any other shape —
# a different failing test, more than one, or a suite that did not collect —
# means the harness is wrong and the arm would prove nothing. The judgement
# lives in assert-suite.mjs so check-flow.sh can exercise it directly.
assert_suite() {
  node "$FLOW_DIR/assert-suite.mjs" "$1" "$2" "$EXPECTED_TESTS" "$REGRESSION_TEST"
}

echo "== worktree with the regression =="
git -C "$REPO" worktree add --detach "$WT" "$BASELINE" >/dev/null
git -C "$WT" apply "$FLOW_DIR/$REGRESSION_PATCH_NAME"
(cd "$WT" && pnpm install --frozen-lockfile --prefer-offline >/dev/null)

echo "== red baseline: the known regression, alone =="
(cd "$WT" && ./node_modules/.bin/vitest run --config vitest.config.ts "$CHECK_TEST" \
  --reporter=json --outputFile="$ROOT/logs/red-$ARM.json" >"$ROOT/logs/red-$ARM.log" 2>&1) || true
if assert_suite "$ROOT/logs/red-$ARM.json" red 1; then
  echo "  ok: 1 failure, and it is the regression"
else
  echo "  ABORT: the baseline is not the expected red; the arm would prove nothing" >&2
  exit 1
fi

echo "== isolated service =="
"$TSX" "$REPO/apps/tui/bin/clankie.ts" herdr set --runtime bundled >/dev/null
"$TSX" "$REPO/apps/tui/bin/clankie.ts" model refresh >/dev/null
"$TSX" "$REPO/apps/tui/bin/clankie.ts" model set "$MODEL" >/dev/null
"$TSX" "$REPO/apps/tui/bin/clankie.ts" effort set medium >/dev/null
"$TSX" "$REPO/apps/tui/bin/clankie.ts" workdir set "$WT" >/dev/null
"$TSX" "$REPO/apps/tui/bin/clankie.ts" model status | tee "$ROOT/logs/selection-$ARM.json"
# Job control puts the service in its own process group, so teardown can signal
# exactly that tree and nothing else.
set -m
(cd "$REPO" && exec "$TSX" apps/clankie/src/index.ts >"$ROOT/logs/service-$ARM.log" 2>&1) &
SERVICE_PGID=$!
set +m
for _ in $(seq 1 45); do curl -fsS -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS -m 3 "http://127.0.0.1:$PORT/health" || { echo "  service did not become healthy" >&2; exit 1; }
echo
[ -S "$HERDR_SOCK" ] || { echo "  ABORT: no private Herdr socket; it may have joined a fleet" >&2; exit 1; }
echo "  ok: private Herdr at $HERDR_SOCK"

echo "== arm =="
if "$TSX" "$REPO/apps/clankie/scripts/comparison-run.ts" \
  --base "http://127.0.0.1:$PORT" --brief "$BRIEF" --title "case A $ARM" --timeout 1500000 \
  >"$ROOT/logs/run-$ARM.json" 2>"$ROOT/logs/run-$ARM.err"; then
  echo "  turn settled completed"
else
  echo "  turn did not settle completed (artifacts kept)"
  RESULT=1
fi

echo "== correctness: the arm's source alone against the FROZEN test =="
git -C "$REPO" worktree add --detach "$VERIFY" "$BASELINE" >/dev/null
cp "$WT/$SUBJECT" "$VERIFY/$SUBJECT"
(cd "$VERIFY" && pnpm install --frozen-lockfile --prefer-offline >/dev/null)
(cd "$VERIFY" && ./node_modules/.bin/vitest run --config vitest.config.ts "$CHECK_TEST" \
  --reporter=json --outputFile="$ROOT/logs/green-$ARM.json" >"$ROOT/logs/green-$ARM.log" 2>&1) || true
if assert_suite "$ROOT/logs/green-$ARM.json" green 0; then
  echo "  PASS: frozen test green, all $EXPECTED_TESTS tests"
else
  echo "  FAIL: the frozen check did not pass cleanly" >&2
  RESULT=1
fi

git -C "$WT" diff >"$ROOT/logs/agent-$ARM.diff"
git -C "$WT" diff -- "$SUBJECT" >"$ROOT/logs/source-only-$ARM.diff"
git -C "$WT" status --porcelain >"$ROOT/logs/touched-$ARM.txt"
cp "$ROOT/state/captain/turn-settled.jsonl" "$ROOT/logs/turn-settled-$ARM.jsonl" 2>/dev/null || true
cp "$BRIEF" "$ROOT/logs/brief-sent-$ARM.md"
echo "done: $ROOT/logs (exit $RESULT)"
exit "$RESULT"
