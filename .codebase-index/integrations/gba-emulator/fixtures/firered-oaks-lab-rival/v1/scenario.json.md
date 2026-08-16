# integrations/gba-emulator/fixtures/firered-oaks-lab-rival/v1/scenario.json

`RealGbaRouteScenarioSchema` fixture for the
expanded gameplay proof in
`pallet-town/professor-oaks-lab`: goal
`trainer_battle_won` facing south, with party
and inventory menu proof required. Pins the
FireRed ROM, the `firered-oaks-lab-starter-v1`
savestate, and the core wasm; 256-decision /
256-event budgets, 8 hold-frames per step.
Selected via `CLANKIE_GBA_SCENARIO_PATH` with
the matching operator-local savestate; the
live-proof run produces the two-core
byte-identical receipt from it.
