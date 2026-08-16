# packages/interactive-environment/src/minecraft.ts

The Minecraft Java profile over the shared
environment contract.

- `MinecraftActionSchema` — typed action union:
  navigate, follow, collect, craft, smelt, equip,
  place, interact, attack (hostile_mob|player),
  eat, sleep, wait; wrapped by
  `MinecraftActionRequestSchema` with
  `MinecraftActionLimitsSchema` (radius, timeout,
  block-change quota, combat policy).
- `MinecraftCommandSchema` — the shared command
  set with the typed start_action, and a join
  refinement requiring the `minecraft_java`
  resource profile.
- `MinecraftObservationSchema` — presence,
  inventory, entities, action, danger, and chat
  (chat data carries `untrusted: true`).
- Tool exposure: `MinecraftToolNameSchema` (11
  tools), `resolveMinecraftToolExposure(phase,
lane)` — off/failed expose join+status only,
  gameplay lane gets observe/start/status/cancel,
  supervision lanes get steer/pause/disconnect;
  `MinecraftToolExposureSchema` superRefines
  against the resolver so a forged exposure fails.
