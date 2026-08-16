# scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json

The frozen GBA fixture itself (schemaVersion 1).
Defines the deterministic world: core
gba-core-double-v1, savestate
verdant-path-savestate-v1 identified by digest
(never the bytes), RNG seed 20260719, world
gba-emulator-lab-v1, and evidence bounds
(maxEvidenceEvents/maxDecisions 64).

Content: an 8x6 map "verdant-path" with blocked
tiles (2,2)/(2,3); player clankie starting at
(0,1) with party embercub lv8 (tackle 3, ember 5)
and leafling lv7 (vine-tap 4); trainer rival-mira
at (4,1), interaction distance 1, opponent
sproutlet lv6 hp12 retaliating for 2; target
location (3,1). Expected: battleResult "won",
minimum 6 decisions. Exact bytes are pinned by
the sibling scenario.sha256 — never reformat.
