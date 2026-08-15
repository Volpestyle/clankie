# integrations/minecraft-mineflayer/src/real-motor.ts

`RealMineflayerMotorFactory` /
`RealMineflayerMotor` — the pinned Mineflayer
4.37.1 + mineflayer-pathfinder 2.4.5
implementation of the motor for Paper 1.21.11.

Connection (`connectMineflayer`): loopback
config only, offline-lab or Microsoft auth
(an interactive MSA prompt fails the connect —
device codes are never surfaced), pathfinder
movements with digging, parkour, sprinting,
and 1x1 towers disabled, spawn + chunk-load
gated with a timeout. Actions: navigate
(GoalNear, radius clamped 1-4), collect (finds
nearest matching blocks, digs with the best
tool, verifies pickup landed in inventory —
walking onto the drop if needed), craft
(inventory recipes only, verifies produced
count), place (empty target above solid
support, verified after placement), wait. All
wrapped in `abortable()` so a cancel fences
pathfinder goal, control states, and digging.
Every outward string/number is bounded and
finiteness-checked; registry names and
dimensions are validated by regex.
