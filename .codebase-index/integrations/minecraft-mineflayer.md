# integrations/minecraft-mineflayer

`@clankie/minecraft-mineflayer` — Clankie's
Minecraft Java body for a frozen, private,
loopback-only Paper laboratory.
`MineflayerMinecraftAdapter` sits behind
`EnvironmentRuntime` and never exposes
Mineflayer objects, credentials, or server
controls to a model lane.

Children:

- `src/` — contracts, the motor interface and
  its real Mineflayer implementation, the
  adapter, the frozen collect/craft/place
  scenario, live-run readiness, Paper pins.
- `scripts/` — pinned Paper download and a
  readiness report.
- `test/` — adapter suite with a fake motor;
  readiness checks.
- `README.md` — boundary and live-proof guide.

Boundary: the server host must be literal
127.0.0.1/::1; the only capabilities are
bounded observe / navigate / collect / craft /
place / wait — no combat, commands, chat
output, teleport, or public joins. Long
actions return a running handle and settle out
of band so pause, cancel, lease expiry, and
emergency stop stay live mid-path. Mineflayer
completion is not success authority — the
separate Paper verifier's console observation
produces the only accepted goal-verified
result.
