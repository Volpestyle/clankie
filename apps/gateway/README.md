# Public gateway

The public gateway is Clankie's thin AWS doorway from
[ADR 0151](../../docs/adr/0151-the-public-doorway-routes-home.md), with account
enrollment from
[ADR 0153](../../docs/adr/0153-an-account-signs-the-mac-in.md). It holds no
Clankie, conversations, terminal state, grants, or device sessions. Optional push
delivery stores device-authorized routing registrations ([ADR 0159](../../docs/adr/0159-the-device-authorizes-push-delivery.md)). A configured Mac opens
one authenticated outbound WebSocket; the gateway routes the existing public
control and operator-relay HTTP contracts over it.

The source is public ([ADR 0311](../../docs/adr/0311-the-doorway-source-is-public.md)).
The private operations repository builds it into the image behind
`api.clankie.bot`; this repository never deploys it.

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

- `GET /h/{hostId}/v1/gateway/challenge` obtains a one-use host challenge.
- `POST /h/{hostId}/v1/gateway/encrypted` carries authenticated ciphertext for
  pairing, device self/refresh, push reference, conversation/control, artifact
  downloads and native terminal traffic. No device bearer appears outside it.
- `GET /h/{hostId}/v1/gateway/stream` upgrades to a phone's call socket
  ([ADR 0289](../../docs/adr/0289-a-call-through-the-gateway-is-a-sealed-stream.md)).
  It carries no bearer. The first message is the device's sealed opening, as
  text, and every later message both ways is one sealed binary record of at most
  16 KiB, passed on unread. Only a Mac that connected with
  `x-clankie-gateway-streams: 1` is offered one, two at a time. Refusals: 404
  for a Mac that doesn't carry calls, 503 for no Mac, 400 for a bearer, and 429
  for no room or opens over budget (12 in a burst per host, 24 per client).
  Close codes are passed through `sendableStreamCloseCode` before use, and a
  Mac that goes away ends its calls with 1001.
- `POST /gateway/v1/push/registrations` and `/gateway/v1/push/registrations/clear`
  carry delivery metadata and a one-use encrypted device authorization proof.
- `/h/{hostId}/v1/hooks/linear` carries separately signed third-party webhooks.
- The Claude connector ([ADR 0301](../../docs/adr/0301-claude-reaches-the-fleet-through-a-narrow-connector.md))
  is plaintext, because Claude speaks ordinary OAuth and MCP and the Mac
  authenticates every call: `POST|GET /h/{hostId}/mcp` (the only plaintext
  route that may carry `Authorization`), its RFC 9728 document at
  `/h/{hostId}/.well-known/oauth-protected-resource/mcp`, RFC 8414 metadata at
  `/h/{hostId}/.well-known/oauth-authorization-server`, and `/oauth/register`,
  `/oauth/authorize` (the only route that keeps a query), `/oauth/authorize/status`
  and `/oauth/token` under `/h/{hostId}`. Root discovery with the host after the
  suffix (`/.well-known/oauth-authorization-server/h/{hostId}`,
  `/.well-known/oauth-protected-resource/h/{hostId}/mcp`) reaches the same host.
  Responses keep `www-authenticate` and the sign-in page's content policy.
  Connector calls are budgeted per host (240 in a burst, 8 a second), because
  Claude's servers share a few addresses; the sign-in page and its polling are
  also budgeted per client (60, 2 a second). Refusals are
  `429 connector_rate_limited` with `Retry-After`. This route lets the gateway
  read pane text and messages on their way through; the app's own traffic stays
  encrypted.
- `/gateway/v1/hosts/connect?hostId=…&installationId=…` is the account-authenticated
  Mac WebSocket. The one-parameter form is the temporary legacy bearer route.
- `POST /gateway/v1/telemetry` takes the app's diagnostics batch
  ([`@clankie/protocol/app-telemetry`](../../packages/protocol/src/app-telemetry.ts)):
  closed event names, outcomes, durations and short codes. No Authorization, so
  an app can report while it cannot reach its host. Sign-up is open, so every
  limit assumes a hostile caller. Behind Caddy all callers share one peer, so
  the budgets bound the whole route:
  - 100 requests in a burst and 5 a second, checked before the body is read;
  - 400 events in a burst and 10 a second after validation, which caps log
    lines and ingestion cost;
  - 12 batches per host route.

  Refusals are `429 telemetry_throttled` with `Retry-After`, summarized in at
  most one `gateway telemetry throttled` line a minute. Batches are capped at
  8 KiB and rejected whole on any unknown field. They are never forwarded to a
  host; each event is logged as one `app telemetry` line. A batch is the app's
  own claim; nothing trusts it for authorization.

Offer publication completes only after the gateway returns a
`pairing_route_ready` acknowledgment. The Mac does not expose a QR/code before
that acknowledgment, so an immediate scan cannot outrun route registration.

A pairing route may expire at most
`PUBLIC_GATEWAY_PAIRING_ROUTE_LIFETIME_MAX_MS` (31 days) in the future, the
constant `@clankie/protocol/public-gateway` shares with the Mac's review-offer
cap ([ADR 0154](../../docs/adr/0154-a-review-offer-outlives-the-window.md)).
A route past that window closes the host socket. Release the gateway before
any Mac mints `clankie pair --review`: an older gateway still enforces fifteen
minutes and drops the Mac connection, including on every reconnect replay,
until that review offer expires or is redeemed.

Join transport ([ADR 0212](../../docs/adr/0212-machines-and-devices.md)) adds five POST-only routes under `/h/{hostId}`:
`/v1/machine-joins/start`, `/v1/machine-joins/status`, and
`/v1/joined-machines/challenge`, `/channel`, `/leave`.
They require a currently authenticated outbound connection from a self-hosted
Mac. The gateway forwards original
bytes and validates only the strict public outer schemas. Bootstrap exposes
name, platform, proposed directories, an unprivileged claim secret and the
approval hash to the gateway; none are logged or stored here. Status alone
accepts that 43-character claim bearer, which retrieves only the sealed lease.
The locally generated approval code and execution token never travel in plaintext.
Channel and leave use independently authenticated encrypted machine envelopes;
the body verifies registry identity and one-use challenges, and the receiver
checks its original consent ceiling and directories before effects.

`/v1/machine-joins/approve` remains inside the ordinary encrypted device request
with owner/Take Control authorization. Sending it directly returns `426`.
Query strings, unknown fields, sender-supplied grants and plaintext execution
bearers are refused. Bodies are capped at 16 KiB except channel's 2 MiB.
Before parsing, separate peer and destination-host buckets limit start to a
burst of 32 and 0.2/s, and other join transport to 512 and 256/s. Buckets have a
4096-key cardinality cap and ten-minute idle eviction. Trusted-proxy address
handling is shared with other admission routes; arbitrary forwarded addresses
cannot bypass it. Refusals return `429 machine_join_rate_limited` with
`Retry-After`. These limits constrain admission, not machine authorization.
An unavailable Mac returns `503`.

[The product test](test/public-gateway-path.test.ts) drives the real
HTTP gateway, outbound connector, service, encrypted device approval and native
shell receiver for a Mac on a legacy host token and on a signed-in account. It
covers leave and revoked reconnect. This is local fixture evidence, not a
deploy or real Windows capture. Shipping the gateway requires a separate owner deployment.

Other plaintext application routes and public short-code redemption return `426`.
Unknown routes return `404`; an unavailable Mac returns `503`. Offer expiry and
single-use checks remain inside the encrypted host response.

Cancelling an HTTP request retires only that exchange. Late response frames
for a retired request are discarded: they have no destination and cannot
disconnect other requests on the Mac's shared socket. Responses for an active
exchange still require its owning host connection and valid frame sequencing.

Every relayed exchange answers with `x-clankie-request-id`, the opaque id the
gateway also logs, so the app can quote it in diagnostics.

Structured logs contain host id, request id, status, byte count, duration, and
connection state only. The gateway never logs authorization headers, pairing
capabilities, request bodies, or response bodies. Lines carry an `event` code
for a central log store:
`gateway.exchange.completed`, `gateway.exchange.failed` for every exchange the
gateway ends itself (`host_unavailable`, `gateway_timeout`,
`gateway_response_limit`, `gateway_busy`, `cancelled` as status 499),
`gateway.host.connected`, and `gateway.host.disconnected` with its WebSocket
`closeCode` and `connectedMs`.

## Push delivery

Push is opt-in and off unless `CLANKIE_GATEWAY_PUSH_CONFIG_FILE` names a
readable JSON file. Without it the gateway boots exactly as before, and a host
asking for a wake is told `unavailable` — pairing and messaging are untouched.

```json
{
  "teamId": "ABCDE12345",
  "keyId": "FGHIJ67890",
  "topic": "io.clankie.v2",
  "privateKeyFile": "/run/secrets/apns.p8",
  "databasePath": "/var/lib/clankie-gateway/push.sqlite"
}
```

Everything in that file is a path or an Apple identifier. The signing key is
read from `privateKeyFile`; no key material, device token, delivery key, or
grant belongs in it, and an unknown field is refused rather than ignored. A
configured-but-wrong deployment fails at boot — bad JSON, a bad field, a missing
key, or a key that is not EC P-256 — and the error names the file and the field
without printing either's contents. `databasePath` must be an absolute path;
`:memory:` is refused, because losing the database revokes every phone's
delivery authorization until each app registers again.

`topic` is the App Store bundle id and one gateway serves exactly one. A host
cannot choose a topic, a title, or a body: it names a device, a conversation,
and a registration version, and the gateway builds the rest.

The environment (`sandbox` or `production`) is **not** in this file. Each
registration carries its own. Development-signed builds use sandbox; TestFlight
and App Store builds use production. The registered environment must match the
artifact's [signed entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment).

Registration and clear requests share a 30-request burst per connecting peer,
refilling at one per second, before any host lookup. Behind Caddy the peer is
the proxy, so the allowance is shared; caller-supplied forwarding headers cannot
change it. A `429 push_throttled` leaves the app's pending intent for a later
retry. Authenticated account wake allowance is separate (60 burst, one per
second), with at most 32 APNs sends in flight.

### Host files the activator expects

| Path                             | Owner and mode                        | Mounted at                            | Why                                               |
| -------------------------------- | ------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| `/etc/clankie-gateway/push.json` | `root:root` `0644`                    | `/run/config/push.json` (read-only)   | paths and identifiers only                        |
| `/etc/clankie-gateway/apns.p8`   | `root:clankie-gateway-secrets` `0640` | `/run/secrets/apns.p8` (read-only)    | the signing key; the container joins group `1999` |
| `/var/lib/clankie-gateway/push`  | uid `1000` `0700`                     | `/var/lib/clankie-gateway` (writable) | the registration database                         |

```bash
sudo install -d -o 1000 -g 1000 -m 0700 /var/lib/clankie-gateway/push
sudo install -o root -g clankie-gateway-secrets -m 0640 apns.p8 /etc/clankie-gateway/apns.p8
sudo install -o root -g root -m 0644 push.json /etc/clankie-gateway/push.json
```

uid 1000 is `node`, the user the runtime image runs as; the activator refuses to
start a push-enabled release whose image runs as anyone else, because the
directory ownership above would then be wrong. The container stays
`--read-only`: that data directory is the single writable mount.

This requires **activator version 3 or later** (`activate-release.sh
--version`). An older activator ignores `push.json` entirely and the gateway
boots without push — visible in the startup line, which reports `push: false`.

### Persistence and backup

The registration database _is_ the delivery authorization: rows bind a token to
one host and one registration version, and the app's key hash is what lets it
move that binding. Restoring an old copy re-enables registrations a phone has
since cleared, so a stale backup is worse than none — prefer letting apps
re-register over restoring. It holds APNs device tokens, so treat a copy of it
like the tokens themselves: `0600`, never in an image, never in a log.
Losing it is recoverable (each app re-registers on next launch); leaking it
exposes which devices exist and lets nothing be sent, since sending also needs
the signing key.

The gateway runs one process on one Lightsail instance. Device-to-host
application encryption ends on the Mac, independently of TLS termination at
Caddy. [ADR 0173](../../docs/adr/0173-the-gateway-cannot-read-device-traffic.md)
describes the threat model, exposed metadata, wire contract and recovery.
Durable route coordination is added only when a second gateway process is
justified by measured load.

## Encryption recovery

Pair with the current app using the secure QR or full pasted link from
`clankie pair`; an old public session cannot downgrade to plaintext. The host
broker retains the ticket-wrapping key across restarts. Session refresh rotates
the device encryption key and ticket while retaining live grant checks.
`clankie gateway rotate-encryption-key` (also in `/gateway`) replaces the host
wrapping key. Coordinate the captain restart separately, then re-pair every
device. The command never restarts a running service itself.

A connected doorway with `invalid_encrypted_request` means an expired, rotated,
replayed or mismatched encrypted identity: obtain a fresh QR after checking host
selection. `encryption_required` / `secure_pairing_required` means the client
needs an update or a secure pairing link. These errors never print keys,
tickets, capabilities or decrypted bodies.

## Per-client budgets

Unauthenticated routes (push registration, machine-join admission) are
budgeted per client. Behind Caddy every socket peer is Caddy, so the gateway
takes the last `X-Forwarded-For` entry as the client, but only when the peer is
the container named by `CLANKIE_GATEWAY_TRUSTED_PROXY` (the activator sets
`clankie-caddy`, re-resolved on each heartbeat). Caddy replaces any client-sent
value with the address it saw. From any other peer the header is ignored.

## Retired hosted routes

Hosted Clankie was retired. The gateway no longer accepts fleet-signed host
credentials from hosted bodies, reports device activity to a fleet, forwards
body wakes, relays hosted pair offers, support or operator envelopes, Discord
ingress or Activity media, or routes hosted credits. Those paths now answer
`426` or `404` like any other plaintext or unknown route and never reach a Mac.
The process refuses to start while any `CLANKIE_GATEWAY_FLEET_*` setting is
present, so a host still configured for the fleet fails loudly instead of
silently dropping it.
