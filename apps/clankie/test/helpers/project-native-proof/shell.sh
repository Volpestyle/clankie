#!/bin/sh
# A genuine foreground shell must fail the trusted Node launcher check.
control=$1
client_script=$2
name=$3
endpoint=$4
pane=$5
HERDR_SOCKET_PATH=$6
session=$7
node_binary=$8
export HERDR_SOCKET_PATH
herdr pane report-agent "$pane" --source project-proof-fixture --agent codex --state idle --agent-session-id "$session" >/dev/null || exit 1
"$node_binary" "$client_script" "$control" "$name" "$endpoint" "$pane"
