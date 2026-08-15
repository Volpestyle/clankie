# apps/tui/src/session/lane-observation.ts

`/trace` — watching a room the operator is not
talking in (ADR 0083). Rooms come from the service's
authenticated identity-only `/captain/v1/lanes`
listing (`createCaptainLaneClient`, schema-validated);
no per-event stream exists yet, so a watched lane
reports session rotations and state transitions, not
reasoning/tool feeds. Subscriber only: no send, no
steering.

`selectLanes` resolves an argument (whole lane, exact
`guild:channel` key or target id, `all` minus the
tui lane, or substring); `formatLaneListing` renders
the sorted listing with watch markers. `followLane`
polls one room at 2s, backing a quiet room off
exponentially to 15s, de-duplicating error notices,
and reporting rotations/transitions through
callbacks. `CaptainLaneTraceController` owns
concurrent tails keyed by `laneKey`
(attach/detach/detachAll), rendering each change as
a room-tagged transcript block.
