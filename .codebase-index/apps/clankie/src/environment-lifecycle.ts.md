# apps/clankie/src/environment-lifecycle.ts

Composition factories putting concrete game
bodies behind the durable `EnvironmentRuntime`:
`createRunnerEnvironmentLifecycle` (generic),
`createRunnerMinecraftEnvironmentLifecycle`
(Mineflayer motor, injectable for tests), and
`createRunnerGbaEnvironmentLifecycle`.

The GBA variant binds a frozen scenario +
fixture sha256, falls back to the deterministic
core double without a `coreFactory` (runnable
with no ROM), and wires an optional
rendered-surface frame sink (ADR 0047): one
`GbaFrameStream` per lifecycle keeps rate-limit
and dedupe state across `publishFrame()` calls,
with the frame source late-bound through a
holder. Frames leave only through this seam,
never the semantic event stream.
