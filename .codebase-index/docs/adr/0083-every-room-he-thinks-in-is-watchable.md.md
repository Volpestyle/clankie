# docs/adr/0083-every-room-he-thinks-in-is-watchable.md

Every room writes one canonical append-only
`LaneLog` JSONL file keyed by `(lane, targetId)`,
with bounded `heard` and `said` records only. The
TUI lane view and `observe_room` read this same
history; `GET /captain/v1/lanes` exposes the
bounded projection under captain authentication.

Pi session trees, reasoning, continuation state,
provider credentials, and steering are outside
the route by construction. One-shot Discord text
turns still leave a durable room history without
becoming durable model sessions.
