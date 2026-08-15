# packages/interactive-environment/src/environment.ts

The shared environment contract every profile
builds on. Ids come from `@clankie/protocol`.

Sessions & leases:

- `EnvironmentResourceBoundsV1Schema` — frozen,
  Minecraft-shaped v1 bounds.
- `EnvironmentResourceBoundsV2Schema` —
  discriminated union on `profile`:
  `minecraft_java`, `legacy_v1` (v1 + the original
  environmentKind), `pokemmo_simulator` (map ids,
  step/menu/battle quotas), `gba_emulator` (core
  id, pinned savestate id+sha256, rng seed, input/
  frame budgets).
- `EnvironmentSessionSpecV1/V2Schema` + union;
  superRefines enforce world/character binding and
  environmentKind ↔ profile match.
  `normalizeEnvironmentSessionSpec` dual-reads v1
  and single-writes v2 (minecraft_java or
  legacy_v1).
- `EnvironmentLeaseV1/V2Schema` + union with
  timestamp-ordering refinement;
  `normalizeEnvironmentLease(input, session)`
  binds a lease to its session's bounds.

Commands & actions:

- `EnvironmentCommandSchema` — join (authority
  must match the session's requestedBy), status,
  cancel_join, start_action, action_status,
  cancel_action, steer, pause, resume, disconnect;
  every command carries `IntentContextSchema`
  (lane, authority, correlation, expected goal
  version).
- `EnvironmentActionResultSchema` — status union:
  queued/running handle, completed (outcome),
  cancelled, failed (errorCode+retryable), denied,
  stale (goal-version mismatch).

Events:

- `EnvironmentSemanticEventTypeSchema` — closed
  enum spanning environment._, minecraft._,
  pokemmo.*, discord presence phase change, and
  captain lane/intent events.
- `EnvironmentSemanticEventDataSchema` — a closed
  union of bounded state-transition payloads; raw
  ticks/chunks/packets/audio/video have no shape
  here.
- `EnvironmentTelemetryReferenceSchema` — the
  artifact_reference plane (`artifact://` URIs)
  for anything high-volume.
- `EnvironmentEventSchema` — semantic |
  artifact_reference discriminated on `plane`.

Also: `EnvironmentSessionPhaseSchema` (off/
starting/active/paused/stopping/failed),
`EnvironmentObservationSchema` (generic), GBA and
PokeMMO capability enums used by the bounds.
