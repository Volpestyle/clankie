# integrations/minecraft-mineflayer/src

The Minecraft body: a small motor interface,
its real Mineflayer implementation, the
governed adapter, and the frozen scenario
runner, plus live-run readiness and Paper
pins.

- `contracts.ts` — capabilities, the
  loopback-only connection config schema, and
  motor data types.
- `motor.ts` — the `MineflayerMotor` /
  `MineflayerMotorFactory` interfaces the
  adapter drives (and tests fake).
- `real-motor.ts` — the pinned Mineflayer +
  pathfinder implementation.
- `adapter.ts` — `MineflayerMinecraftAdapter`:
  binding validation, capability/bounds
  enforcement, async action lifecycle,
  observations.
- `scenario.ts` — the frozen YAML
  collect-craft-place scenario, its session
  spec, and the runner.
- `readiness.ts` — live-run preflight (JDK 21,
  Paper identity, EULA).
- `paper-build.ts` — the pinned Paper
  1.21.11-132 constants and cache paths.
- `index.ts` — barrel.
