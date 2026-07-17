#!/usr/bin/env bash
# Liveness watcher for pane-hosted worker lanes.
#
# Root-cause fix (run 2026-07-16-m1m2-wave): a pane can go `blocked` — Codex
# cyber-filter refusal, provider capacity, or a swallowed re-arm confirmation —
# and produce no sentinel. A done-only watcher then sits silent until its
# multi-hour timeout. This watcher returns the moment EITHER all lanes finish
# (DONE/BLOCKED sentinel) OR any pane flips to `blocked` status, so a stall
# surfaces in one poll interval instead of hours.
#
# Usage: watch-lanes.sh <pane_id>:<sentinel_dir> [<pane_id>:<sentinel_dir> ...]
#   sentinel_dir is a directory expected to gain a `DONE` or `BLOCKED` file.
# Exits 0 with STALLED/ALL-DONE line naming which lane and why.

set -u
INTERVAL="${WATCH_INTERVAL:-25}"
MAX_TICKS="${WATCH_MAX_TICKS:-960}"   # 960 * 25s = ~6.7h ceiling
pairs=("$@")

pane_status() {
  herdr pane list 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(next((p.get('agent_status','?') for p in d['result']['panes'] if p['pane_id']=='$1'),'missing'))" 2>/dev/null
}

for ((t=0; t<MAX_TICKS; t++)); do
  done_count=0
  for pair in "${pairs[@]}"; do
    pane="${pair%%:*}"; dir="${pair#*:}"
    if [[ -e "$dir/DONE" || -e "$dir/BLOCKED" ]]; then
      done_count=$((done_count+1)); continue
    fi
    st="$(pane_status "$pane")"
    if [[ "$st" == "blocked" ]]; then
      echo "STALLED $pane ($dir) status=blocked tick=$t — needs attention (/goal resume, confirm dialog, or reroute)"
      exit 0
    fi
  done
  if [[ "$done_count" -eq "${#pairs[@]}" ]]; then
    echo "ALL-DONE ${#pairs[@]} lane(s) reached a sentinel"
    exit 0
  fi
  sleep "$INTERVAL"
done
echo "WATCH-TIMEOUT after ~$((MAX_TICKS*INTERVAL))s"
exit 1
