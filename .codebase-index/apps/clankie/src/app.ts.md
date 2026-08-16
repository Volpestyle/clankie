# apps/clankie/src/app.ts

The whole HTTP surface (Hono) plus the durable
JSONL event log. `createClankieApp(deps)` builds
every route, replays stored events into the
projections (devices, Discord presence,
user-session opt-in, embodiment, captain
presence), and returns `{ app, embodiment,
captainPresence, presenceSessions, voiceHistory,
close }`.

Injected deps: the captain port, memory, media
generator, browser tools, activity observations,
Discord presence runtimes, body-possession
reader, device session key, and the three
authenticators (runner, captain, operator).
Absent deps make their routes answer 503 —
capabilities fail closed, never crash.

Route families:

- `/health`, `/v1/discord/readiness`.
- `/v1/discord/voice-briefing` — server-composed
  realtime voice briefing (ADR 0057): persona +
  lane instructions + surface rules + self-state
  - embodiment card + consented person memory,
    bounded to 8k chars; content-free receipt
    event.
- `/v1/discord/presence-*` — phase events into
  the durable projection (idempotent by event
  id, revision-fenced), session list, voice
  history, operator status, and
  `presence-actions` guarded by live-claim
  headers + transport bound to authentication +
  user-session opt-in.
- `/v1/captain/channel-turns` — one Discord
  message = one captain turn; idempotent per
  deliveryId with fingerprint conflict (409),
  lane authority enforced (voice vs text).
- `/v1/memory/...` — Discord person facts
  (proposal applies directly now), operator
  export/delete, captain episodes; a
  Discord-scoped bearer can never read the
  operator lane.
- `/v1/captain/presence` — heartbeat lease
  ingestion.
- `/v1/embodiment/...` — intents, live session
  (+ operator stop kill-switch), activity
  snapshot (identity-checked against the live
  session), runner claim/report, possession.
- `/v1/browser/...` and media routes —
  captain-or-operator auth; approval-required
  browser tools need an operator.
- `/v1/pairing/*` + `/v1/devices/*` — offer →
  redeem → complete pairing, session refresh
  (grants from the projection, never the token),
  list, revoke.
- Operator conversation dispatch + lane
  observation — the captain's HTTP face for TUI
  and relay (shared captain token).

Notable helpers: `createBearerAuthenticator`
(hash + timingSafeEqual), `withSerializedLock`
keyed promise chains, `PROFILE_HASH =
"unversioned"` filling the doctrine-era wire
slot, `persistable()` dropping heartbeats from
disk, and the voice-briefing render helpers at
the bottom.
