# packages/interactive-environment

Provider-neutral zod contracts for durable
embodied environments: session phases, leases,
commands, action results, observations, semantic
events, telemetry references, and deterministic
lane-scoped tool exposure. Profiles cover
Minecraft Java, the deterministic PokeMMO
simulator, the GBA emulator, and Discord presence
(ADR 0024). Runtime adapters (mineflayer, the
emulator, the bridges) implement these; this
package is the stable protocol boundary.

Read-only play sight complements the live
activity digest with one bounded PNG still or a
small story card projected from the play journal;
neither endpoint can control the body.

Children:

- `README.md` — contract overview
- `package.json` — @clankie/interactive-environment
- `src/` — one module per profile + the shared
  environment contract
- `test/` — per-profile contract suites + fixtures
- `tsconfig.json` — standard noEmit config

src modules:

- `environment.ts` — shared v1/v2 session specs,
  leases, resource-bounds union, commands, action
  results, the closed semantic-event payload
  union, telemetry references
- `minecraft.ts` — Minecraft actions/observations/
  tool exposure
- `pokemmo.ts` — simulator contracts + the live
  read-only capability boundary
- `emulator.ts` — GBA actions (button_press,
  walk_to, advance_dialog, enter_text,
  select_menu_entry…), observations, the
  local-only capability boundary
- `discord-presence.ts` — presence phases, session
  records, the frozen action catalog, lane
  addressing
- `rendered-surface.ts` — activity-plane frame and
  overlay schemas
- `activity-observation.ts` — latest-only
  self-observation read contract
- `play-sight.ts` — pull-on-demand live still and
  bounded story-card read contracts

Cross-cutting rules: strict schemas with bounded
strings everywhere; raw ticks/packets/audio/video
are rejected from the semantic plane and travel
only as `artifact://` telemetry references;
gameplay tools appear only in the active
`gameplay` lane; tool-exposure schemas superRefine
against the canonical resolver so a forged
exposure fails to parse; v2 session/lease
contracts dual-read the frozen Minecraft-shaped
v1 via `normalizeEnvironmentSessionSpec` /
`normalizeEnvironmentLease`.
