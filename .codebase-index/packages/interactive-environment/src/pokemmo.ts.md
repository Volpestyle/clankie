# packages/interactive-environment/src/pokemmo.ts

The deterministic PokeMMO simulator profile, plus
the live-game read-only boundary.

- `PokeMMOSimulatorActionSchema` — navigate,
  interact, menu_choice, battle_move and
  party_switch (both pinned to an expectedTurn),
  item_use (battleId ⇔ expectedTurn required
  together), wait. Bounded by
  `PokeMMOSimulatorActionLimitsSchema`.
- `PokeMMOSimulatorSessionSpecSchema` — strict v2
  spec over `pokemmo_simulator` bounds with world/
  character binding refinements.
- `PokeMMOCommandSchema` — join/status/cancel_join/
  start_action/action_status/cancel_action/steer/
  pause/resume/disconnect (own schemaVersion 1).
- `PokeMMOObservationSchema` — overworld, menu,
  party (HP-consistency refinement), inventory,
  battle, dialog, danger, action; text-bearing
  kinds carry `untrusted: true`.
- Tool exposure mirrors the Minecraft pattern:
  `resolvePokeMMOSimulatorToolExposure` +
  forgery-rejecting exposure schema.
- Live boundary: `POKEMMO_LIVE_CAPABILITY_BOUNDARY`
  admits exactly `pokemmo.live.observe` and
  `pokemmo.live.coach`; `actionCapabilities` is
  typed `z.array(z.never())`, so keyboard/packet/
  memory/anticheat capabilities are
  unrepresentable. `isPokeMMOLiveCapabilityAllowed`
  is the runtime check.
