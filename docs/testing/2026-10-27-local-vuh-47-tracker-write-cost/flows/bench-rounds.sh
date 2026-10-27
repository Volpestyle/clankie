#!/bin/zsh
# Runs the LOCAL-VUH-42 write bench on scratch copies of migrated stores, plain and --hire,
# and appends one JSON line per run with the 1-minute load average before and after (LOCAL-VUH-47).
#
#   bench-rounds.sh LABEL CHECKOUT STORES_DIR SCRATCH_DIR OUT.jsonl DAYS...
#
# STORES_DIR/<days> holds a migrated store (tracker.json + tracker.journal). Each run copies it
# into SCRATCH_DIR and deletes the copy; HOME and XDG point into SCRATCH_DIR, so no live store,
# keychain or settings are touched. CHECKOUT is the tree whose packages/work-items is measured:
# interleave a base checkout and the change, one round each, to compare at the same load.
label=$1; checkout=$2; stores=$3; scratch=$4; out=$5; shift 5
home=$scratch/home; mkdir -p $home
for days in "$@"; do
  for mode in plain hire; do
    work=$scratch/$label-$days-$mode; rm -rf $work
    flag=(); [[ $mode == hire ]] && flag=(--hire)
    before=$(sysctl -n vm.loadavg | awk '{print $2}')
    line=$(cd $checkout && clankie heavy -- env HOME=$home XDG_CONFIG_HOME=$home/.config XDG_STATE_HOME=$home/.state XDG_DATA_HOME=$home/.data \
      node docs/testing/2026-10-27-local-vuh-42-tracker-journal/flows/bench-writes.ts --store $stores/$days --scratch $work --writes 40 $flag | tail -1)
    after=$(sysctl -n vm.loadavg | awk '{print $2}')
    echo "{\"label\":\"$label\",\"days\":$days,\"mode\":\"$mode\",\"load1Before\":$before,\"load1After\":$after,\"result\":$line}" >> $out
    rm -rf $work
  done
done
