# packages

Shared contracts and adapters consumed by the
apps. `protocol` depends on nothing but zod;
everything else layers on it, from durable
environment lifecycles and Discord presence to
credentials, settings, models, and media.

- `protocol` — every zod schema, frozen table,
  and type that crosses a process boundary
  (lanes, operator conversations, presence,
  voice, embodiment, pairing, memory, media).
- `api-client` — typed `ClankieApiClient` for
  the service's API, validating both
  directions and attaching the right bearer
  per route.
- `credential-broker` — the local secret
  boundary: Keychain/file stores, HMAC
  capability grants with audited one-time use,
  every broker-owned internal bearer, and Linear
  MCP OAuth.
- `settings` — operator-facing non-secret
  config in a 0600 settings.json; env
  overrides win and are reported; Discord,
  persona, voice, Linear, and email coordinates;
  token-shaped values are refused.
- `observability` — pino logger factory with
  secret redaction, `withSpan` OTel helper,
  support-bundle sanitization.
- `model-provider` — config + registry +
  broker credentials → ready-to-call AI SDK
  models; provider/role resolution, reasoning
  variants, subscription OAuth.
- `model-registry` — models.dev catalog with
  vendored snapshot, atomic on-disk cache,
  pure query helpers.
- `body-lock` — cross-process lockfile mutex:
  one writer for the GBA body, dead-holder
  reclaim, read-only observer.
- `discord-presence-core` — transport-neutral
  Discord participation for both bodies: text
  ingress, presence lifecycle, two-tier realtime
  voice, screen sight, YouTube music, and
  content-free receipts.
- `environment-runtime` — durable
  single-writer lifecycle and lease
  enforcement for embodied sessions:
  idempotent dispatch, restart
  reconciliation, emergency stop.
- `interactive-environment` — provider-neutral
  zod contracts for embodied environments:
  sessions, leases, commands, observations,
  semantic events, rendered surfaces, and
  pull-on-demand play still/story reads.
- `media-connector` — versioned boundary for
  local image/video generation (OpenAI,
  Google, Grok adapters), hardened artifact
  writing, job-style video.
- `possessor-voice` — loopback WebSocket seam
  for a body-driving possessor to report
  events for the persona to voice; bearer-
  gated, lossy by design.
- `rendered-surface-client` — dial-out
  WebSocket sink publishing gameplay frames
  and the monologue overlay to the activity
  plane; drops frames rather than replaying
  stale ones.

## Flow

Contracts (`protocol`,
`interactive-environment`) are the base;
runtime enforcement (`environment-runtime`,
`body-lock`) sits on them; transport adapters
(`discord-presence-core`, `possessor-voice`,
`rendered-surface-client`, `media-connector`,
`api-client`) carry them between processes;
`credential-broker`, `settings`,
`model-provider`, `model-registry`, and
`observability` supply secrets, config,
models, and logging to all of it.
