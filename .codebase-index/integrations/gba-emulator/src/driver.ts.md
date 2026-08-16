# integrations/gba-emulator/src/driver.ts

State-derived driver for the frozen double
scenario: every decision is a pure function of
the latest observations (`decideNextGbaAction`)
— no phase script, no input transcript.

`driveGbaScenario` loops observe → decide →
act → verify: BFS route step toward the
target, engage the trainer, advance dialog,
pick the strongest move (argmax over power,
XOR cursor navigation), and halts on
battle_won / uncertain state / failed action /
budget. After every act it verifies the frame
counter advanced; a stale frame fails closed
instead of pressing blind. `GbaDriverIo` is
the observe/act/pause/resume handle the
scenario runner binds to
`EnvironmentRuntime.startAction`.
