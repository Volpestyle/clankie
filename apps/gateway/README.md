# Public gateway

The public gateway is Clankie's thin AWS doorway from
[ADR 0151](../../docs/adr/0151-the-public-doorway-routes-home.md), with account
enrollment from
[ADR 0153](../../docs/adr/0153-an-account-signs-the-mac-in.md). It holds no
Clankie, conversation, terminal, grant, or device state. A configured Mac opens
one authenticated outbound WebSocket; the gateway routes the existing public
control and operator-relay HTTP contracts over it.

## Authentication and local use

Production mounts the public Cognito discovery document at
`CLANKIE_GATEWAY_ACCOUNT_CONFIG_FILE`. The gateway serves it from
`GET /gateway/v1/config` and verifies Mac access tokens directly against the
issuer's JWKS. A Mac route is derived from the authenticated account subject and
its random installation id, so there is no host registry.

The legacy `CLANKIE_GATEWAY_HOST_TOKENS_FILE` path remains during migration. It
points to a JSON object from opaque host id to a random token of at least 32
characters. The inline JSON forms exist only for local development; configuring
both file and inline forms for one source fails closed.

```bash
export CLANKIE_GATEWAY_HOST_TOKENS_JSON='{"mac_example_123456":"replace-with-at-least-32-random-characters"}'
pnpm --filter @clankie/gateway start
```

The process listens on `PORT` (default `8080`) and
`CLANKIE_GATEWAY_HOST` (default `0.0.0.0`). `GET /health` is the deployment
health route.

## Public surface

- `POST /v1/pairing/redeem` hashes the presented short-lived capability and
  routes it through the Mac that registered the same hash.
- `/h/{hostId}/v1/pairing/complete` and the device self/refresh routes go to
  the Mac's Clankie service.
- `/h/{hostId}/operator/v1/{dispatch,tail,terminal-tail}` goes to the Mac's
  operator relay.
- `/gateway/v1/hosts/connect?hostId=…&installationId=…` is the account-authenticated
  Mac WebSocket. The one-parameter form is the temporary legacy bearer route.

Offer publication completes only after the gateway returns a
`pairing_route_ready` acknowledgment. The Mac does not expose a QR/code before
that acknowledgment, so an immediate scan cannot outrun route registration.

Everything else is `404`. An unavailable Mac is `503`; an expired or unknown
pairing capability is `410`.

Structured logs contain host id, request id, status, byte count, duration, and
connection state only. The gateway never logs authorization headers, pairing
capabilities, request bodies, or response bodies.

The initial deployment intentionally runs one process on one Lightsail instance
for the invited beta. TLS terminates at Caddy on that host, so the gateway
process can technically read forwarded content even though it neither records
nor interprets it. App-layer encryption remains required before unrelated
customers share it. Durable route coordination is added only when a second
gateway process is justified by measured load.
