# integrations/gba-emulator/src/scenario.ts

`runFrozenGbaScenario` — the end-to-end runner
for the frozen double scenario: builds the
session spec, stands up an
`EnvironmentRuntime` with the adapter, drives
`driveGbaScenario`, then assembles the
validated `GbaScenarioReport` with its checks
(target reached, battle won, decisions
state-derived, evidence bounded, inputs within
bounds) and artifact references.

Uses a fixed clock and a runner-private grant
token, and asserts that token never leaks into
any emitted evidence. Emits the goal semantic
event via `gbaEmulatorGoalEvent`. Fully
deterministic — this is what CI runs without a
ROM.
