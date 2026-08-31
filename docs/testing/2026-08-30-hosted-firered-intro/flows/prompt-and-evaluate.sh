#!/bin/sh
set -eu

if [ "${1:-}" = "" ]; then
  echo "usage: prompt-and-evaluate.sh <clankie-tui-pane-id>" >&2
  exit 2
fi

herdr pane run "$1" "Play FireRed in the PokeAgents hosted world. Join with pokeagent_join_mmo. Get through Oak intro, name yourself CLANKIE, confirm the name, then stop playing. Stay on this TUI — skip Discord voice. Narrate briefly here as you go."

echo "wait for ~/.local/state/clankie/gba-play/*embodiment*.jsonl to grow a summary, then:" >&2
echo "pnpm --filter @clankie/play gameplay:evaluate-journal -- <journal> --events ~/.clankie/events.jsonl" >&2
