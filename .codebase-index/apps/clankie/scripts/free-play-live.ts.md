# apps/clankie/scripts/free-play-live.ts

Dev alias for watching Clankie play
(`pnpm gba:free-play-live`). Drives the exact
production play composition
(`createGbaPlayExecution`) with a locally
fabricated `EmbodimentSession` — no running
service, no Discord ask needed.

Reads `CLANKIE_FREE_PLAY_TURNS` (default 20) as
the turn budget, feeds stdin lines into an
`InterjectionQueue` so typed text reaches the
next turn, and stops at the next turn boundary on
SIGINT. Start `@clankie/discord-activity` first
or frames are dropped and counted in the receipt.
Prints the outcome (turns, frames published/
dropped, checkpoint) and exits non-zero on
refusal.
