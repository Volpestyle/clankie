# Public gateway

The public gateway is Clankie's thin AWS doorway from
[ADR 0151](../../docs/adr/0151-the-public-doorway-routes-home.md), with account
enrollment from
[ADR 0153](../../docs/adr/0153-an-account-signs-the-mac-in.md). It holds no
Clankie, conversations, terminal state, grants, or device sessions. Optional push
delivery stores device-authorized routing registrations ([ADR 0159](../../docs/adr/0159-the-device-authorizes-push-delivery.md)). A configured Mac opens
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
- `/h/{hostId}/v1/devices/self/push` records the device's delivery reference on its Mac.
- `POST /gateway/v1/push/registrations` and `/gateway/v1/push/registrations/clear`
  authorize or clear delivery at this gateway (when push is configured).
- `/h/{hostId}/operator/v1/{dispatch,tail,terminal-tail}` goes to the Mac's
  operator relay.
- `/gateway/v1/hosts/connect?hostId=…&installationId=…` is the account-authenticated
  Mac WebSocket. The one-parameter form is the temporary legacy bearer route.

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

Everything else is `404`. An unavailable Mac is `503`; an expired or unknown
pairing capability is `410`.

Structured logs contain host id, request id, status, byte count, duration, and
connection state only. The gateway never logs authorization headers, pairing
capabilities, request bodies, or response bodies.

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

The initial deployment intentionally runs one process on one Lightsail instance
for the invited beta. TLS terminates at Caddy on that host, so the gateway
process can technically read forwarded content even though it neither records
nor interprets it. App-layer encryption remains required before unrelated
customers share it. Durable route coordination is added only when a second
gateway process is justified by measured load.
