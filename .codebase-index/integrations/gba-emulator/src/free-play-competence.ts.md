# integrations/gba-emulator/src/free-play-competence.ts

The free-play competence gate: a benchmark
that runs pinned states through the free-play
loop and requires objective milestone
progress, turn-budget efficiency, distinct
accepted actions, and no unresolved stall —
a repeat-only controller fails even when every
press is accepted.

Schemas: benchmark definition (states pin
scenario/savestate ids and digests; milestones
are reached_position / entered_map / dialog /
battle started/won / menu_observed /
distinct_tiles), per-run metrics and checks,
the benchmark report, and a content-free
operator receipt (asserts no ROM/savestate/
frame/transcript/model bytes persisted).

`runFreePlayCompetenceBenchmark` runs each
state through `createFreePlaySession` +
`runFreePlay` with a state-derived benchmark
mind (`createStateDerivedFreePlayBenchmarkMind`
— walk_to target, advance dialog, strongest
move) or a caller-supplied mind; a
`CompetenceTracker` records milestones,
repeated-input runs, and stall windows.
`evaluateFreePlayCompetenceReceipt` loads the
canonical benchmark independently, recomputes
every check and derived metric, requires the
exact ROM-gated state set, and compares a
fresh operator-local rerun against the stored
report.
