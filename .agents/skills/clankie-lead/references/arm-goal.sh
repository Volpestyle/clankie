#!/usr/bin/env bash
# Preflight and arm a pane-hosted worker's native /goal loop.
#
# Usage:
#   arm-goal.sh --receipt-dir DIR <pane_id> <condition>
#   arm-goal.sh --receipt-dir DIR --file CONDITION_FILE <pane_id>

set -u -o pipefail

MAX_GOAL_CHARS=4000
STATUS_TIMEOUT_MS="${ARM_STATUS_TIMEOUT_MS:-15000}"
VERIFY_DELAY_SECONDS="${ARM_VERIFY_DELAY_SECONDS:-3}"
VERIFY_TAIL_LINES="${ARM_VERIFY_TAIL_LINES:-30}"
READINESS_TIMEOUT_SECONDS="${ARM_READINESS_TIMEOUT_SECONDS:-90}"
READINESS_POLL_SECONDS="${ARM_READINESS_POLL_SECONDS:-3}"
SUBMIT_RETRIES="${ARM_SUBMIT_RETRIES:-3}"

usage() {
  echo "usage: arm-goal.sh --receipt-dir DIR [--file CONDITION_FILE] <pane_id> [condition]" >&2
}

receipt_dir=""
condition_file=""
positionals=()

while (($#)); do
  case "$1" in
    --receipt-dir)
      if (($# < 2)); then
        usage
        exit 2
      fi
      receipt_dir="$2"
      shift 2
      ;;
    --file)
      if (($# < 2)); then
        usage
        exit 2
      fi
      condition_file="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      while (($#)); do
        positionals+=("$1")
        shift
      done
      ;;
    -*)
      echo "arm-goal: unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      positionals+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$receipt_dir" ]]; then
  echo "arm-goal: --receipt-dir is required" >&2
  usage
  exit 2
fi
if ((${#positionals[@]} == 0)); then
  echo "arm-goal: pane id is required" >&2
  usage
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "arm-goal: jq is required" >&2
  exit 2
fi

pane_id="${positionals[0]}"
mkdir -p "$receipt_dir"

write_failure_receipt() {
  local receipt_name="$1"
  local message="$2"
  local observed_line="${3:-}"
  local temporary_receipt

  temporary_receipt="$(mktemp "$receipt_dir/.${receipt_name}.XXXXXX")" || return 1
  if ! jq -n \
    --arg pane_id "$pane_id" \
    --arg error "$message" \
    --arg observed_error_line "$observed_line" \
    --arg recorded_at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    '{pane_id: $pane_id, error: $error, observed_error_line: $observed_error_line, recorded_at: $recorded_at}' \
    >"$temporary_receipt"; then
    rm -f "$temporary_receipt"
    return 1
  fi
  mv "$temporary_receipt" "$receipt_dir/$receipt_name"
}

fail_arm() {
  local message="$1"
  local observed_line="${2:-}"
  write_failure_receipt ARM_FAILED "$message" "$observed_line" || true
  echo "arm-goal: $message" >&2
  [[ -z "$observed_line" ]] || echo "arm-goal: observed: $observed_line" >&2
  exit 1
}

fail_spawn() {
  local message="$1"
  local observed_line="${2:-}"
  write_failure_receipt SPAWN_FAILED "$message" "$observed_line" || true
  echo "arm-goal: $message" >&2
  [[ -z "$observed_line" ]] || echo "arm-goal: observed: $observed_line" >&2
  exit 1
}

last_nonempty_line() {
  local text="$1"
  local line
  local last=""
  while IFS= read -r line; do
    [[ -z "$line" ]] || last="$line"
  done <<<"$text"
  printf '%s' "$last"
}

recent_text_contains() {
  local text="$1"
  local needle="$2"
  local recent_text=""
  local line_count=0
  local line

  while IFS= read -r line; do
    recent_text="${recent_text}${line}"$'\n'
    line_count=$((line_count + 1))
    if ((line_count > VERIFY_TAIL_LINES)); then
      recent_text="${recent_text#*$'\n'}"
      line_count=$VERIFY_TAIL_LINES
    fi
  done <<<"$text"
  [[ "$recent_text" == *"$needle"* ]]
}

last_composer_line() {
  local text="$1"
  local line
  local composer_line=""
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*'›'[[:space:]] ]]; then
      composer_line="$line"
    fi
  done <<<"$text"
  printf '%s' "$composer_line"
}

# Startup markers that mean the harness is not yet accepting submitted input.
# "MCP startup incomplete" and "failed to start" are terminal warnings, not
# in-progress markers, so they intentionally do not block readiness.
harness_still_starting() {
  local text="$1"
  recent_text_contains "$text" "Starting MCP servers"
}

# Goal-armed confirmation vocabulary differs per harness:
#   Codex shows "Pursuing goal"; Claude Code shows "/goal active" (also seen as
#   "Goal active"). Accept the union — the pane's harness is not always known.
confirmed_pursuing() {
  local text="$1"
  recent_text_contains "$text" "Pursuing goal" \
    || recent_text_contains "$text" "/goal active" \
    || recent_text_contains "$text" "Goal active"
}

if [[ -n "$condition_file" ]]; then
  if ((${#positionals[@]} != 1)); then
    echo "arm-goal: pass a condition with --file or as one quoted argument, not both" >&2
    usage
    exit 2
  fi
  if [[ ! -r "$condition_file" ]]; then
    fail_arm "condition file is not readable: $condition_file"
  fi
  condition="$(<"$condition_file")"
else
  if ((${#positionals[@]} != 2)); then
    echo "arm-goal: condition must be one quoted argument (or use --file)" >&2
    usage
    exit 2
  fi
  condition="${positionals[1]}"
fi

# Compose-time lint intentionally precedes every Herdr lookup or send.
condition_length=${#condition}
if ((condition_length == 0)); then
  fail_arm "goal condition is empty"
fi
if ((condition_length > MAX_GOAL_CHARS)); then
  fail_arm "goal condition is ${condition_length} characters; maximum is ${MAX_GOAL_CHARS}; nothing was sent"
fi
if [[ "$condition" == *$'\n'* || "$condition" != *prompt.md* || "$condition" != *DONE* || "$condition" != *BLOCKED* ]]; then
  echo "arm-goal: warning: non-standard goal condition; use one line pointing to prompt.md and requiring a DONE or BLOCKED sentinel" >&2
fi

if ! command -v herdr >/dev/null 2>&1; then
  fail_spawn "herdr is unavailable; pane preflight could not run" "command not found: herdr"
fi

pane_list_output="$(herdr pane list 2>&1)"
pane_list_exit=$?
if ((pane_list_exit != 0)); then
  fail_spawn "herdr pane list failed with exit ${pane_list_exit}" "$(last_nonempty_line "$pane_list_output")"
fi
if ! printf '%s' "$pane_list_output" | jq -e . >/dev/null 2>&1; then
  fail_spawn "herdr pane list returned invalid JSON" "$(last_nonempty_line "$pane_list_output")"
fi
pane_record="$(printf '%s' "$pane_list_output" | jq -c --arg pane_id "$pane_id" 'first(.result.panes[] | select(.pane_id == $pane_id)) // empty')"
if [[ -z "$pane_record" ]]; then
  fail_spawn "pane does not exist: $pane_id" "pane_id=$pane_id missing from herdr pane list"
fi

agent_status="$(printf '%s' "$pane_record" | jq -r '.agent_status // "unknown"')"
case "$agent_status" in
  idle|working|blocked|done) ;;
  *) fail_spawn "pane has not reached a reporting interactive harness" "agent_status=$agent_status" ;;
esac

pane_text="$(herdr pane read "$pane_id" --source recent-unwrapped --lines 80 --format text 2>&1)"
pane_read_exit=$?
if ((pane_read_exit != 0)); then
  fail_spawn "pane text could not be read (exit ${pane_read_exit})" "$(last_nonempty_line "$pane_text")"
fi

fatal_line=""
shopt -s nocasematch
while IFS= read -r line; do
  if [[ "$line" =~ the[[:space:]]+operator[[:space:]]+console[[:space:]]+requires[[:space:]]+a[[:space:]]+TTY ]] \
    || [[ "$line" =~ command[[:space:]]+not[[:space:]]+found:[[:space:]]*(clankie|codex|claude|pi) ]] \
    || [[ "$line" =~ (clankie|codex|claude|pi).*(stdin|terminal).*(not[[:space:]]+a[[:space:]]+tty|requires[[:space:]]+a[[:space:]]+tty) ]]; then
    fatal_line="$line"
    break
  fi
done <<<"$pane_text"
shopt -u nocasematch
if [[ -n "$fatal_line" ]]; then
  fail_spawn "pane shows a fatal harness launch error" "$fatal_line"
fi

if [[ ! "$STATUS_TIMEOUT_MS" =~ ^[0-9]+$ || ! "$VERIFY_DELAY_SECONDS" =~ ^[0-9]+$ || ! "$VERIFY_TAIL_LINES" =~ ^[1-9][0-9]*$ \
  || ! "$READINESS_TIMEOUT_SECONDS" =~ ^[0-9]+$ || ! "$READINESS_POLL_SECONDS" =~ ^[1-9][0-9]*$ || ! "$SUBMIT_RETRIES" =~ ^[0-9]+$ ]]; then
  fail_arm "ARM_STATUS_TIMEOUT_MS, ARM_VERIFY_DELAY_SECONDS, ARM_VERIFY_TAIL_LINES, ARM_READINESS_TIMEOUT_SECONDS, ARM_READINESS_POLL_SECONDS, and ARM_SUBMIT_RETRIES must be non-negative integers (tail lines and poll seconds must be positive)"
fi

# Readiness gate: typing into a harness that is still starting (e.g. Codex
# "Starting MCP servers (…)") gets the trailing Enter swallowed — the goal
# text then sits unsubmitted in the composer while the worker idles.
readiness_waited=0
while harness_still_starting "$pane_text"; do
  if ((readiness_waited >= READINESS_TIMEOUT_SECONDS)); then
    fail_spawn "pane harness still starting after ${READINESS_TIMEOUT_SECONDS}s" "$(last_nonempty_line "$pane_text")"
  fi
  sleep "$READINESS_POLL_SECONDS"
  readiness_waited=$((readiness_waited + READINESS_POLL_SECONDS))
  pane_text="$(herdr pane read "$pane_id" --source recent-unwrapped --lines 80 --format text 2>&1)"
  pane_read_exit=$?
  if ((pane_read_exit != 0)); then
    fail_spawn "pane text could not be read during readiness wait (exit ${pane_read_exit})" "$(last_nonempty_line "$pane_text")"
  fi
done

# A stale composer can prefix the slash command and leave the combined text
# unsubmitted. Move to the end and clear the complete composer before typing.
clear_output="$(herdr pane send-keys "$pane_id" ctrl+e ctrl+u 2>&1)"
clear_exit=$?
if ((clear_exit != 0)); then
  fail_arm "clearing the pane composer failed with exit ${clear_exit}" "$(last_nonempty_line "$clear_output")"
fi

send_output="$(herdr pane send-text "$pane_id" "/goal $condition" 2>&1)"
send_exit=$?
if ((send_exit != 0)); then
  fail_arm "sending /goal text failed with exit ${send_exit}" "$(last_nonempty_line "$send_output")"
fi
enter_output="$(herdr pane send-keys "$pane_id" Enter 2>&1)"
enter_exit=$?
if ((enter_exit != 0)); then
  fail_arm "sending Enter after /goal failed with exit ${enter_exit}" "$(last_nonempty_line "$enter_output")"
fi

# Submission verification: if the composer still holds the /goal text the
# Enter was swallowed (seen live when a harness finished startup between the
# readiness read and the send). Re-press Enter a bounded number of times.
submit_attempt=0
while :; do
  sleep 1
  submit_text="$(herdr pane read "$pane_id" --source recent-unwrapped --lines 80 --format text 2>&1)" || submit_text=""
  submit_composer="$(last_composer_line "$submit_text")"
  [[ "$submit_composer" == *"/goal "* ]] || break
  if ((submit_attempt >= SUBMIT_RETRIES)); then
    fail_arm "the /goal command remains in the pane composer after ${SUBMIT_RETRIES} Enter retries" "$submit_composer"
  fi
  submit_attempt=$((submit_attempt + 1))
  echo "arm-goal: /goal still in composer; re-pressing Enter (attempt ${submit_attempt}/${SUBMIT_RETRIES})" >&2
  enter_output="$(herdr pane send-keys "$pane_id" Enter 2>&1)"
  enter_exit=$?
  if ((enter_exit != 0)); then
    fail_arm "re-pressing Enter failed with exit ${enter_exit}" "$(last_nonempty_line "$enter_output")"
  fi
done

working_output="$(herdr wait agent-status "$pane_id" --status working --timeout "$STATUS_TIMEOUT_MS" 2>&1)"
working_exit=$?
if ((working_exit != 0)); then
  fail_arm "pane did not report working after /goal (exit ${working_exit})" "$(last_nonempty_line "$working_output")"
fi

sleep "$VERIFY_DELAY_SECONDS"
verify_text="$(herdr pane read "$pane_id" --source recent-unwrapped --lines 80 --format text 2>&1)"
verify_read_exit=$?
if ((verify_read_exit != 0)); then
  fail_arm "pane text could not be read after arming (exit ${verify_read_exit})" "$(last_nonempty_line "$verify_text")"
fi

if recent_text_contains "$verify_text" "Replace current goal?"; then
  echo "arm-goal: confirming deliberate replacement of the current goal in pane $pane_id" >&2
  confirm_output="$(herdr pane send-keys "$pane_id" Enter 2>&1)"
  confirm_exit=$?
  if ((confirm_exit != 0)); then
    fail_arm "answering Replace current goal? failed with exit ${confirm_exit}" "$(last_nonempty_line "$confirm_output")"
  fi
  working_output="$(herdr wait agent-status "$pane_id" --status working --timeout "$STATUS_TIMEOUT_MS" 2>&1)"
  working_exit=$?
  if ((working_exit != 0)); then
    fail_arm "pane did not report working after goal replacement (exit ${working_exit})" "$(last_nonempty_line "$working_output")"
  fi
  sleep "$VERIFY_DELAY_SECONDS"
  verify_text="$(herdr pane read "$pane_id" --source recent-unwrapped --lines 80 --format text 2>&1)"
  verify_read_exit=$?
  if ((verify_read_exit != 0)); then
    fail_arm "pane text could not be read after goal replacement (exit ${verify_read_exit})" "$(last_nonempty_line "$verify_text")"
  fi
fi

if ! confirmed_pursuing "$verify_text"; then
  fail_arm "goal arm could not be confirmed as pursuing" "$(last_nonempty_line "$verify_text")"
fi
composer_line="$(last_composer_line "$verify_text")"
if [[ "$composer_line" == *"/goal "* ]]; then
  fail_arm "the /goal command remains in the pane composer instead of being submitted" "$composer_line"
fi

echo "ARMED $pane_id status=pursuing condition_chars=$condition_length"
