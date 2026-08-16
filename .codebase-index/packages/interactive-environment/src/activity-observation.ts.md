# packages/interactive-environment/src/activity-observation.ts

Latest-only self-observation for an activity
Clankie is currently doing — a read contract, not
an action surface, so a captain in another lane
can answer "what am I playing?" without another
lane's continuation token or raw state.

- `GbaActivityObservationSnapshotSchema` — one
  settled free-play turn: bounded `selfAuthored`
  (objective/intent/commentary — model-authored,
  not runner authority) kept structurally separate
  from `runnerObserved` (outcome enum, effect,
  tile/map progress counters, framebufferSha256
  digest only — never frame bytes).
- `ActivityObservationSnapshotSchema` — surface
  union (gba_emulator today).
- `ActivityObservationReadSchema` — outcome union:
  `snapshot`, `pending` (live session, no settled
  turn yet — not permission to guess), or
  `not_playing`.
