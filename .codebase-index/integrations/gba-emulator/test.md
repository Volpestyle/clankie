# integrations/gba-emulator/test

Vitest suites. Most run ROM-free against the
deterministic double or scripted seam cores;
suites that need the real ROM (parts of
real-mgba, map-grid, map-exits) gate on
`CLANKIE_GBA_ROM_PATH` +
`CLANKIE_GBA_SAVESTATE_PATH` and skip
otherwise.

Coverage by file: the composite actions each
get a suite with a scripted core built to
exercise the stops (advance-dialog,
enter-text, select-menu-entry); gba-emulator
is the big adapter/runtime/frozen-scenario
suite; real-mgba covers the libretro ABI and
the real route scenario; map-grid and
map-exits cover pathing, the minimap, and exit
decoding against synthetic memory; firered-
state decodes synthetic EWRAM/IWRAM;
firered-core pins the battle-outcome mapping;
the free-play-* files cover the loop, journal,
progress, session/body-lock, boot, voice,
prompts (real SDK validation vs mocked
timeout), character rules, and the competence
benchmark; checkpoint, frame-stream, and
live-proof cover their namesake modules.
