#!/bin/sh
# Three real heavy holders on the scratch registry (1 slot): one runs, two wait; release one every 30 s.
cd "$(git rev-parse --show-toplevel)"
F=packages/fleet-resources/test/fixtures
G=.local/views-tui/fleet-resources
H=.local/views-tui/holders
for seat in board-alpha board-beta board-gamma; do
  node $F/heavy-driver.mjs $G $seat "$(command -v node)" $F/heavy-command.mjs hold $H/$seat.receipt $H/$seat.release $G &
  echo "$(date +%T) started $seat"
  sleep 3
done
for seat in board-alpha board-beta board-gamma; do
  sleep 30
  touch $H/$seat.release
  echo "$(date +%T) released $seat"
done
wait
echo "$(date +%T) all holders exited"
