#!/usr/bin/env bash
# One case-B arm: a captain leads three Claude Code workers to implement
# VUH-1115, against an isolated second service.
#
#   ./run-arm.sh --arm terra|astra --root DIR [--port N] [--check]
#
# --root must be a NEW absolute directory; each arm needs its own.
# --check validates every prerequisite and exits, starting nothing.
#
# The owner's ~/.config/clankie, live service and Herdr fleet are never written.
# Teardown harvests and closes this arm's private workers BEFORE stopping the
# service that owns their Herdr, so their final status is recorded rather than
# lost, and it signals only the process group this script created.
set -euo pipefail

# Bash reads a script incrementally by byte offset. An edit to this file while
# an arm is running — even a correct one — makes the interpreter resume at a
# stale offset and misparse the remainder. That destroyed the 2026-09-04 Terra
# arm after its job had already completed. Run from an immutable snapshot so
# the executing bytes cannot change underneath a 45-minute run.
if [ "${CASE_B_PINNED:-}" != "1" ]; then
  __snapshot=$(mktemp -t case-b-run-arm)
  cat "${BASH_SOURCE[0]}" >"$__snapshot"
  chmod +x "$__snapshot"
  if CASE_B_PINNED=1 CASE_B_FLOW_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) \
    bash "$__snapshot" "$@"; then
    __status=0
  else
    __status=$?
  fi
  rm -f "$__snapshot"
  exit "$__status"
fi

BASELINE=7afff479
CHECK_SCRIPT=check-arm.mjs
REQUIREMENT=requirement.md.txt
DEADLINE_MS=2700000            # 45 minutes
FLOW_DIR=${CASE_B_FLOW_DIR:?the pinned re-exec must pass the flow directory}
REPO=$(git -C "$FLOW_DIR" rev-parse --show-toplevel)
# tsx is a devDependency of the apps, not of the workspace root.
TSX="$REPO/apps/clankie/node_modules/.bin/tsx"
HERDR_BIN="$REPO/.data/herdr/bin/herdr"

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
[ -n "$ROOT" ] || die "--root DIR is required (a new absolute scratch directory)"
case "$ROOT" in /*) ;; *) die "--root must be an absolute path: $ROOT" ;; esac
case "$ROOT" in */../*|*/./*|*/..|*/.) die "--root must not contain . or .. segments: $ROOT" ;; esac
# -e follows symlinks, so a dangling link would read as absent and then be
# written through. Reject the link itself as well.
{ [ ! -e "$ROOT" ] && [ ! -L "$ROOT" ]; } || die "--root must not already exist (each arm needs a fresh one): $ROOT"
[ "${#ROOT}" -le 60 ] || die "--root is too long for Herdr's sockets: ${#ROOT} > 60"
# Rejects decimals, signs and whitespace as well as words.
case "$PORT" in ''|*[!0-9]*) die "--port must be a whole number: $PORT" ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65524 ] || die "--port must be between 1024 and 65524: $PORT"
RELAY_PORT=$((PORT + 11))

WT="$ROOT/wt-$ARM"
VERIFY="$ROOT/verify-$ARM"

port_free() { ! nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }
fail=0
need() { command -v "$1" >/dev/null 2>&1 || { echo "  MISSING tool: $1" >&2; fail=1; }; }
echo "== prerequisites =="
need git; need node; need pnpm; need nc; need curl; need claude
[ -x "$HERDR_BIN" ] || { echo "  MISSING bundled Herdr: run 'pnpm herdr:build'" >&2; fail=1; }
[ -x "$TSX" ] || { echo "  MISSING tsx: run 'pnpm install'" >&2; fail=1; }
git -C "$REPO" cat-file -e "$BASELINE^{commit}" 2>/dev/null || { echo "  MISSING baseline $BASELINE" >&2; fail=1; }
[ -f "$FLOW_DIR/$REQUIREMENT" ] || { echo "  MISSING $REQUIREMENT" >&2; fail=1; }
[ -f "$FLOW_DIR/$CHECK_SCRIPT" ] || { echo "  MISSING $CHECK_SCRIPT" >&2; fail=1; }
# The worker model and its native settings must exist in the installed CLI, or
# the fixed fleet cannot be honoured and the arms would not be comparable.
claude --help 2>&1 | grep -q -- "--model <model>" || { echo "  claude CLI has no --model" >&2; fail=1; }
claude --help 2>&1 | grep -qE -- "--effort <level>" || { echo "  claude CLI has no --effort" >&2; fail=1; }
claude --help 2>&1 | grep -q '"auto"' || { echo "  claude CLI has no auto permission mode" >&2; fail=1; }
port_free "$PORT" || { echo "  PORT $PORT is in use" >&2; fail=1; }
port_free "$RELAY_PORT" || { echo "  PORT $RELAY_PORT is in use" >&2; fail=1; }
[ "$fail" -eq 0 ] || exit 1
echo "  ok: arm=$ARM model=$MODEL port=$PORT relay=$RELAY_PORT root=$ROOT"

render_requirement() {
  node -e '
    const [src, dest, wt] = process.argv.slice(1);
    const fs = require("node:fs");
    const text = fs.readFileSync(src, "utf8");
    if (!text.includes("__WORKTREE__")) throw new Error("requirement has no __WORKTREE__ placeholder");
    const rendered = text.split("__WORKTREE__").join(wt);
    if (rendered.includes("__WORKTREE__")) throw new Error("placeholder survived substitution");
    if (!rendered.includes(wt)) throw new Error(`worktree path missing: ${wt}`);
    fs.writeFileSync(dest, rendered);
  ' "$1" "$2" "$3"
}
PROBE=$(mktemp)
render_requirement "$FLOW_DIR/$REQUIREMENT" "$PROBE" "$WT"
rm -f "$PROBE"
echo "  ok: requirement substitution (-> $WT)"
"$TSX" "$REPO/apps/clankie/scripts/comparison-run.ts" \
  --base "http://127.0.0.1:$PORT" --brief "$FLOW_DIR/$REQUIREMENT" --check >/dev/null
echo "  ok: driver self-check"
if [ "$CHECK_ONLY" -eq 1 ]; then echo "check only; nothing started"; exit 0; fi

RESULT=0
SERVICE_PGID=""
HERDR_SOCK="$ROOT/state/herdr/herdr.sock"
# Status only. Safe to call while the job is still running.
harvest_status_only() {
  [ -S "$HERDR_SOCK" ] || { echo "  (no private Herdr socket)"; return 0; }
  HERDR_SOCKET_PATH="$HERDR_SOCK" "$HERDR_BIN" agent list >"$ROOT/logs/workers-$ARM.json" 2>/dev/null || true
  node -e '
    const fs = require("node:fs");
    let agents = [];
    try { agents = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result?.agents ?? []; } catch {}
    for (const a of agents) {
      console.log(`  worker ${a.name ?? "(unnamed)"} pane=${a.pane_id} kind=${a.agent} status=${a.agent_status}`);
    }
    if (agents.length === 0) console.log("  (no workers present)");
  ' "$ROOT/logs/workers-$ARM.json"
}

harvest_workers() {
  [ -S "$HERDR_SOCK" ] || return 0
  HERDR_SOCKET_PATH="$HERDR_SOCK" "$HERDR_BIN" agent list >"$ROOT/logs/workers-$ARM.json" 2>/dev/null || true
  node -e '
    const fs = require("node:fs");
    let agents = [];
    try { agents = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result?.agents ?? []; } catch {}
    for (const a of agents) {
      console.log(`  worker ${a.name ?? "(unnamed)"} pane=${a.pane_id} kind=${a.agent} status=${a.agent_status} cwd=${a.cwd}`);
    }
    if (agents.length === 0) console.log("  (no workers present at harvest)");
  ' "$ROOT/logs/workers-$ARM.json"
  # Each worker's own final screen, so a "working" status is evidence, not a guess.
  node -e '
    const fs = require("node:fs");
    let agents = [];
    try { agents = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result?.agents ?? []; } catch {}
    for (const a of agents) console.log(a.pane_id);
  ' "$ROOT/logs/workers-$ARM.json" | while read -r pane; do
    HERDR_SOCKET_PATH="$HERDR_SOCK" "$HERDR_BIN" pane read "$pane" --source recent-unwrapped --lines 60 \
      >"$ROOT/logs/worker-$ARM-$pane.txt" 2>/dev/null || true
    HERDR_SOCKET_PATH="$HERDR_SOCK" "$HERDR_BIN" pane close "$pane" >/dev/null 2>&1 || true
  done
}
CAPTURED=0
REACHED_END=0
capture_source() {
  git -C "$WT" status --porcelain >"$ROOT/logs/touched-$ARM.txt" || return
  git -C "$WT" add -A || return
  # Include new files, binaries and any worker commits before permitting deletion.
  git -C "$WT" diff --cached --binary "$BASELINE" >"$ROOT/logs/agent-$ARM.diff" || return
  git -C "$WT" diff --cached --binary "$BASELINE" -- . \
    ':(exclude)*/test/*' ':(exclude)*.test.ts' ':(exclude)test/*' \
    >"$ROOT/logs/source-only-$ARM.diff" || return
  CAPTURED=1
  git -C "$WT" reset >/dev/null
}
teardown() {
  status=$?
  set +e
  # An abnormal exit — a signal, a parse failure, anything that skipped the end
  # of this script — must never be reported as success.
  if [ "$REACHED_END" -ne 1 ] && [ "$status" -eq 0 ]; then
    echo "  ABNORMAL EXIT: the flow did not reach its own completion marker" >&2
    status=1
  fi
  # Workers first: their Herdr dies with the service that supervises it, so
  # harvesting after the service stops would lose their status entirely.
  harvest_workers
  if [ -n "$SERVICE_PGID" ]; then
    kill -TERM -"$SERVICE_PGID" 2>/dev/null
    sleep 4
    kill -KILL -"$SERVICE_PGID" 2>/dev/null
  fi
  # Never delete an arm's work before its diff was captured. Losing that is
  # unrecoverable; leaving a worktree behind is not.
  if [ "$CAPTURED" -eq 1 ]; then
    git -C "$REPO" worktree remove --force "$WT" 2>/dev/null
    git -C "$REPO" worktree remove --force "$VERIFY" 2>/dev/null
    echo "teardown: workers harvested and closed, service group stopped, worktrees removed"
  else
    echo "teardown: workers harvested and closed, service group stopped" >&2
    echo "  KEPT (uncaptured): $WT" >&2
    echo "  capture never ran, so the arm's work is preserved for manual recovery" >&2
  fi
  echo "evidence kept: $ROOT/logs"
  exit "$status"
}
trap teardown EXIT

mkdir -p "$ROOT/config/clankie" "$ROOT/state" "$ROOT/cache" "$ROOT/logs"
chmod 700 "$ROOT/state"
export XDG_CONFIG_HOME="$ROOT/config" XDG_STATE_HOME="$ROOT/state" XDG_CACHE_HOME="$ROOT/cache"
export CLANKIE_STATE="$ROOT/state" PORT="$PORT" CLANKIE_RELAY_PORT="$RELAY_PORT"
CLANKIE_OPERATOR_TOKEN=$(node -e 'process.stdout.write("clankie_op_"+require("node:crypto").randomBytes(32).toString("base64url"))')
CLANKIE_CAPTAIN_TOKEN=$(node -e 'process.stdout.write("clankie_cap_"+require("node:crypto").randomBytes(32).toString("base64url"))')
export CLANKIE_OPERATOR_TOKEN CLANKIE_CAPTAIN_TOKEN
for name in $(env | sed -n 's/^\(HERDR_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done
unset HERD_LEAD_SUMMARIES_CACHE

echo "== worktree at $BASELINE =="
git -C "$REPO" worktree add --detach "$WT" "$BASELINE" >/dev/null
(cd "$WT" && pnpm install --frozen-lockfile --prefer-offline >/dev/null)

echo "== the frozen check must FAIL at the baseline, for the right reason =="
node "$FLOW_DIR/$CHECK_SCRIPT" --worktree "$WT" --state "$ROOT/baseline-state" \
  >"$ROOT/logs/check-baseline-$ARM.json" 2>&1 && {
  echo "  ABORT: the check passes before the arm ran; it proves nothing" >&2; exit 1; }
# A red that comes from a broken toolchain is not a red. The check reports its
# own harness state; require that to be sound before trusting the failure.
node -e '
  const fs = require("node:fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const harness = report.results.filter((r) => r.id.startsWith("harness.") && !r.ok);
  if (harness.length > 0) {
    console.error(`  ABORT: the baseline red is a harness failure, not a missing feature:`);
    for (const h of harness) console.error(`    ${h.id}: ${h.detail}`);
    process.exit(1);
  }
' "$ROOT/logs/check-baseline-$ARM.json" || exit 1
echo "  ok: red at baseline, harness sound"

echo "== isolated service =="
"$TSX" "$REPO/apps/tui/bin/clankie.ts" herdr set --runtime bundled >/dev/null
"$TSX" "$REPO/apps/tui/bin/clankie.ts" model refresh >/dev/null
"$TSX" "$REPO/apps/tui/bin/clankie.ts" model set "$MODEL" >/dev/null
"$TSX" "$REPO/apps/tui/bin/clankie.ts" effort set medium >/dev/null
"$TSX" "$REPO/apps/tui/bin/clankie.ts" workdir set "$WT" >/dev/null
# Both arms are pinned to the same configured context window through the public
# provider-override surface, so the two runs differ only by model.
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  config.provider = {
    ...config.provider,
    "openai-codex": {
      ...config.provider?.["openai-codex"],
      models: {
        "gpt-6-astra": { limit: { context: 272000 } },
        "gpt-5.6-terra": { limit: { context: 272000 } },
      },
    },
  };
  fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
' "$ROOT/config/clankie/clankie.json"
"$TSX" "$REPO/apps/tui/bin/clankie.ts" model status | tee "$ROOT/logs/selection-$ARM.json"
set -m
(cd "$REPO" && exec "$TSX" apps/clankie/src/index.ts >"$ROOT/logs/service-$ARM.log" 2>&1) &
SERVICE_PGID=$!
set +m
for _ in $(seq 1 45); do curl -fsS -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS -m 3 "http://127.0.0.1:$PORT/health" >"$ROOT/logs/health-$ARM.json" \
  || { echo "  service did not become healthy" >&2; exit 1; }
[ -S "$HERDR_SOCK" ] || { echo "  ABORT: no private Herdr socket; it may have joined a fleet" >&2; exit 1; }
echo "  ok: healthy, private Herdr at $HERDR_SOCK"

echo "== arm: initial turn =="
BRIEF="$ROOT/requirement-$ARM.md"
render_requirement "$FLOW_DIR/$REQUIREMENT" "$BRIEF" "$WT"
cp "$BRIEF" "$ROOT/logs/requirement-sent-$ARM.md.txt"   # raw bytes, never reformatted
JOB_STARTED=$(date +%s)
JOB_STARTED_MS=$(node -e 'process.stdout.write(String(Date.now()))')
JOB_DEADLINE_EPOCH=$(( JOB_STARTED + DEADLINE_MS / 1000 ))
if "$TSX" "$REPO/apps/clankie/scripts/comparison-run.ts" \
  --base "http://127.0.0.1:$PORT" --brief "$BRIEF" --title "case B $ARM" --timeout "$DEADLINE_MS" \
  >"$ROOT/logs/run-$ARM.json" 2>"$ROOT/logs/run-$ARM.err"; then
  echo "  initial turn settled"
else
  echo "  initial turn did not settle completed (artifacts kept)"
  RESULT=1
fi
echo "  workers at initial settle:"
harvest_status_only | tee "$ROOT/logs/workers-at-initial-settle-$ARM.txt"

# An initial turn settling is a YIELD, not the end of the job. `herdr_watch`
# arms a persisted one-shot watch, and a watched pane settling wakes this same
# conversation through submitInternal(..., "watch"). Tearing down here would
# measure initial-turn latency and call it a whole-job result — which is exactly
# what the first case-B attempt did. Nothing is sent below: no nudge, no resume.
echo "== arm: waiting for the whole job to go quiet =="
CONVERSATION=$(node -e '
  const fs = require("node:fs");
  process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).conversationId ?? "");
' "$ROOT/logs/run-$ARM.json")
# The JOB budget, not a fresh window. If the initial turn consumed it, the job
# has already failed its deadline and no extra time is invented here.
if [ -z "$CONVERSATION" ]; then
  echo "  no conversation id in the run receipt; cannot observe the job"
  RESULT=1
elif [ "$(date +%s)" -ge "$JOB_DEADLINE_EPOCH" ]; then
  echo "  the initial turn consumed the whole job budget; not extending it"
  RESULT=1
else
  # The captain's own state directory, which is where captain.ts writes
  # herdr-watches.json: index.ts passes join(CLANKIE_STATE, "captain").
  if "$TSX" "$REPO/apps/clankie/scripts/comparison-await-job.ts" \
    --base "http://127.0.0.1:$PORT" --conversation "$CONVERSATION" \
    --state "$ROOT/state/captain" --socket "$HERDR_SOCK" --herdr "$HERDR_BIN" \
    --job-started-at "$JOB_STARTED_MS" --deadline-at "$(( JOB_DEADLINE_EPOCH * 1000 ))" \
    >"$ROOT/logs/job-$ARM.json" 2>"$ROOT/logs/job-$ARM.err"; then
    echo "  job quiescent"
  else
    echo "  job did not reach quiescence inside the budget"
    RESULT=1
  fi
fi
node -e '
  const fs = require("node:fs");
  try {
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(`  captain runs: ${r.captainRunCount} (${r.captainRuns.map((x) => x.runId).join(", ")})`);
    console.log(`  initial-turn ${r.initialTurnLatencyMs}ms, whole-job ${r.wholeJobLatencyMs}ms`);
    if (r.blockedWorkers?.length) console.log(`  blocked workers (settled but NOT harvested): ${r.blockedWorkers.length}`);
    console.log(`  ${r.reason}`);
  } catch { console.log("  (no job receipt)"); }
' "$ROOT/logs/job-$ARM.json"

echo "== workers at job end =="
harvest_status_only | tee "$ROOT/logs/workers-at-job-end-$ARM.txt"

echo "== source-only patch, verified on a pristine baseline =="
# Everything the arm wrote except its tests: the frozen check must pass on the
# arm's source alone, never alongside tests the arm authored.
capture_source
git -C "$REPO" worktree add --detach "$VERIFY" "$BASELINE" >/dev/null
if [ -s "$ROOT/logs/source-only-$ARM.diff" ]; then
  git -C "$VERIFY" apply "$ROOT/logs/source-only-$ARM.diff" \
    || { echo "  source-only patch did not apply to a pristine $BASELINE" >&2; RESULT=1; }
else
  echo "  the arm changed no source outside tests"
  RESULT=1
fi
(cd "$VERIFY" && pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1)
node "$FLOW_DIR/$CHECK_SCRIPT" --worktree "$VERIFY" --state "$ROOT/verify-state" \
  >"$ROOT/logs/check-$ARM.json" 2>&1 && echo "  PASS: frozen check green on the arm's source alone" \
  || { echo "  FAIL: frozen check red on the arm's source alone"; RESULT=1; }
node -e '
  const fs = require("node:fs");
  try {
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(`  checks ${r.checks}, failed ${r.failed}`);
    for (const c of r.results.filter((x) => !x.ok)) console.log(`    FAIL ${c.id}: ${c.detail}`);
  } catch { console.log("  (check produced no JSON report)"); }
' "$ROOT/logs/check-$ARM.json"

cp "$ROOT/state/captain/turn-settled.jsonl" "$ROOT/logs/turn-settled-$ARM.jsonl" 2>/dev/null || true
REACHED_END=1
echo "done: $ROOT/logs (exit $RESULT)"
exit "$RESULT"
