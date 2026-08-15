# integrations/gba-emulator/scripts/free-play-cli.ts

`pnpm gba:free-play` — headless, Discord-free
free play: the controlled test of whether
Clankie can actually play. ROM-gated (real
FireRed core when `CLANKIE_GBA_ROM_PATH` +
savestate are set, the deterministic double
otherwise); the decisions come from a real
model either way.

Composes `createFreePlaySession` with the
model mind and the separate voice agent, both
under the owner-authored persona's gameplay
register (one character across every surface).
stdin lines become interjections — a person
speaking, not a command channel. Streams each
turn to the console and a per-run JSONL trace
under `artifacts/gba-free-play/` (fresh file
per run so traces never interleave), then
prints accepted/progress/volition/coherence
summaries. Env knobs: turns, frame scale,
trace path, audience, scenario path.
