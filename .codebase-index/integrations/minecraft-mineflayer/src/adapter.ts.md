# integrations/minecraft-mineflayer/src/adapter.ts

`MineflayerMinecraftAdapter` /
`MineflayerMinecraftSession` — the governed
adapter. `start` validates the minecraft_java
profile, parses the runner-private connection
config, checks server/character bindings and
capabilities, connects the motor, and
validates initial presence (approved dimension
and radius) before admitting the session.

Actions are asynchronous: `startAction`
returns `{status: "running", completion}`
immediately and settles out of band, with one
action active at a time, idempotent replay of
completed ids, and a per-action
AbortController + timeout that cancels the
motor. `enforceAction` checks radius, timeout,
block-change quota, combat policy (must be
"none"), capability, and target
dimension/radius against the lease bounds.
Observations: presence, inventory (≤64),
entities (≤256), chat (marked untrusted),
danger, and action status. Pause cancels
in-flight actions; disconnect invalidates the
session (`attach` returns undefined for a
disconnected body — reconnection is a fresh
session, never reanimation).
