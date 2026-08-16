# apps/tui/src/face/clankie-face-bash.ts

The inline `!` shell escape's two testable pieces.
`runFaceBashCommand` spawns `$SHELL -c` (fallback
/bin/zsh) with a 120s timeout and 100KB output cap;
it never rejects — spawn errors resolve as exit 127,
and signal deaths map to conventional codes (timeout
124, SIGINT 130, SIGTERM 143, else 137). `onSpawn`
hands the child out for Ctrl-C wiring.

`formatFaceBashResultLines` /
`ClankieBashResultComponent` render the transcript
block: `$ command` header, wrapped stdout (stderr in
danger color), and an exit/duration footer with
timed-out and truncated notes. The shell owns
bash-mode state and status.
