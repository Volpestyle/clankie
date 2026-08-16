# integrations/gba-emulator/test/free-play-progress.test.ts

Tests `observeEffect` and
`FreePlayProgressTracker` with synthetic
observations: moves, map entries, turns vs
real blocks (refusal memory only on a
same-facing non-move), menu-owned d-pad
presses never minting fake walls, dialog/menu/
battle change summaries, frame-digest
fallbacks, and the tile/stall/efficiency
counters.
