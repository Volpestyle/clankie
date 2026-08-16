# apps/relay

Remote access for the phone/desktop app:
a small Node service exposing two
deliberately separate boundaries for
remote Apple clients. Operator
conversations go over authenticated
HTTP/NDJSON; a legacy loopback-only
development WebSocket carries opaque
`control`/`terminal` planes.

## Children

- `README.md` — boundary doc with a
  mermaid flow of the device → relay →
  service hops and the env config.
- `package.json` — `@clankie/relay`;
  deps are just `ws` and `zod`.
- `src/` — HTTP handler, device auth hop,
  captain dispatch hop, dev WS hub.
- `test/` — vitest suites + recorded
  React Native consumer fixtures.
- `tsconfig.json` — noEmit typecheck
  config.

## Architecture

Each conversation request carries a device
session bearer, verified against the
clankie service's device projection on
every request and between/before tail
pages, so revocation is immediate. The
relay then uses its own captain service
credential (`CLANKIE_CAPTAIN_TOKEN`) for
the upstream hop — device credentials
never cross it. Responses pass the strict
public schema plus a credential redactor
before emission; captain session IDs,
continuation tokens, and provider secrets
never reach a device.

Duplicate sends collapse via an in-memory
idempotency store; tail streams NDJSON
frames (`event`/`recovery`/`auth_failure`)
resuming from opaque cursors. Both the
HTTP router and the legacy tunnel deny
approval-shaped traffic. Tailscale may
transport connections but is never relay
authorization. Listens on
`CLANKIE_RELAY_HOST` (loopback default),
port 4320.
