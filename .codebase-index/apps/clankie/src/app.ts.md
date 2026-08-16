# apps/clankie/src/app.ts

The complete Hono HTTP surface and append-only JSONL service event log. `createClankieApp(deps)` authenticates each caller class, validates protocol schemas, replays durable projections, and returns the app plus in-process embodiment/presence/stream/speech read views and `close()`.

Route families:

- Health/readiness and Discord presence sessions, voice history/briefing, channel turns, active-body actions, user-session opt-in, and stream-watch reports.
- Operator conversation dispatch, lane observation, captain presence.
- Memory catalog plus Discord-person/captain-episode recall, record, edit, delete and export boundaries.
- Embodiment intents/claims/reports/possession plus live activity, pull still, and journal story.
- Browser calls, image/video generation, pairing and device lifecycle.

Discord delivery is idempotent and transport/lane-bound; live-claim headers fence presence actions. Device grants come from projections rather than signed-token claims, operator-only memory mutations require operator auth, and absent optional ports answer typed 503/refusal results instead of widening authority.
