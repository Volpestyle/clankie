# integrations/gba-emulator/src/real-scenario.ts

The real-core scenario family:
`RealGbaRouteScenarioSchema` (ROM/savestate/
core-wasm digests, a probed tile map, start/
target, and a goal of `reach_target` or
`trainer_battle_won` with party/bag proof),
its decision/trace/report schemas, and
`runRealGbaScenario`, the core-independent
state-derived runner.

The loop observes danger/overworld/battle/
dialog/menu each turn and decides: BFS route
step (`nextRealRouteStep`, exported — routes
around `blockedEdges`, the directed
transitions the emulator itself refused),
start-menu navigation to prove party and bag,
dialog advance, battle play (fight cursor,
strongest move), and trainer engagement. After
each step it verifies the move landed, turned,
or was refused — anything else is desync and
fails closed with a pause. The report's checks
include core identity verification, frames
strictly increasing, RAM changing between
decisions, and ≥2 distinct buttons; a
runner-private grant token is asserted absent
from all evidence.
