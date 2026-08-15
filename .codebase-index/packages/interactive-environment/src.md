# packages/interactive-environment/src

- `environment.ts` — the shared foundation: session
  specs/leases (v1+v2), resource-bounds profiles,
  commands, action results, semantic events,
  telemetry references
- `minecraft.ts` — Minecraft Java profile
- `pokemmo.ts` — PokeMMO simulator profile + live
  read-only boundary
- `emulator.ts` — GBA emulator profile
- `discord-presence.ts` — Discord presence plane
- `rendered-surface.ts` — activity frame/overlay
  transport schemas
- `activity-observation.ts` — self-observation
  read contract
- `index.ts` — barrel re-exporting all of the above

Every profile module follows the same pattern:
strict command schemas over a shared base,
discriminated observation unions with `untrusted:
true` literals on text-bearing kinds, a tool-name
enum, a phase+lane → tool-set resolver, and an
exposure schema that superRefines against that
resolver so forged exposures cannot parse.
