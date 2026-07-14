# ADR 0035: Device identity, session tokens, and per-device grants

Status: accepted (VUH-727).

## Context

Pairing is the first-run moment for an iPhone/iPad supervision surface. Until per-device
permissions exist, every connected client is implicitly fully trusted. `clankie pair`
(VUH-878) already mints a single-use offer and the app renders it, but nothing turns an
offer into a durable device identity, records what a device may do, refreshes its access, or
revokes it. VUH-870 enforces terminal scopes at the gateway and explicitly delegates _how a
device receives and loses those scopes_ to this work.

The offer secret is short-lived display data, not a credential. A device needs a long-lived
credential it can present on every request, the control plane needs to know each device's
current grants and liveness authoritatively, and the owner needs to revoke a device such
that every token it holds dies at once. This is a critical security boundary: it must fail
closed on an unknown device, a stale grant, a revoked token, an unknown capability, or a
mismatched control owner.

## Decision

### Two-step redemption honors host-authoritative access review

A device redeems an offer, then completes after the operator-approved access review, matching
the product ruling that grants are shown and confirmed before pairing finishes:

- `POST /v1/pairing/redeem` — the offer secret (from the QR deep link) or the typed code _is_
  the capability, so the route is unauthenticated. It consumes the single-use offer
  synchronously, creates a **pending** device, and returns the offered grants (the Supervise
  preset: chat + steer + terminal-observe) plus a short-lived single-use completion token.
- `POST /v1/pairing/complete` — accepts a subset of the offered grants, activates the device,
  and issues its session token.

Offers and completion tokens live in memory (5-minute and 10-minute TTLs). A control-plane
restart drops in-flight pairings, which then restart — fail closed, identical to how an
outstanding offer behaves. Device records are durable and event-sourced.

### Session tokens carry identity only

A device session token is `base64url(claims).base64url(HMAC-SHA256(key, payload))` with claims
`{version, deviceId, issuedAt, expiresAt, nonce}` — and deliberately **no grants**. Every
request verifies the signature and expiry statelessly, then reads the device's grants and
liveness from the durable projection. Two properties then hold by construction rather than by
discipline:

- **Refresh cannot widen access.** `POST /v1/devices/self/session/refresh` mints a new token but
  sources grants only from the projection, so a refreshed token never carries more than the
  device was granted.
- **Revocation kills every token.** Revocation is per-device, not per-token. A revoked device
  fails every verify regardless of which token is presented, so old and refreshed tokens die
  together the moment the projection flips to `revoked`.

The signing key is a 32-byte mode-0600 file, auto-minted on first run next to the event store
(`CLANKIE_DEVICE_SESSION_KEY_PATH` overrides the path), read without following symlinks. An
unreadable or wrong-mode key makes device authentication return unavailable (503) rather than
trusting an unverifiable key. Deleting or rotating the key revokes every device at once.

### Durable device lifecycle is event-sourced and fail-closed on replay

Device records project from the `device:${deviceId}` stream through `device.pairing.redeemed`,
`device.activated`, `device.session.refreshed`, `device.grant.denied`, and `device.revoked`.
The same transition function runs on live writes and boot replay, so replay parity holds by
construction; an impossible transition or a malformed device event throws at boot, matching the
approval-replay invariant. No event carries token material, a token hash, or the offer secret —
audit trails reference `deviceId` and `offerId` only. Pending-device expiry is a pure function of
the clock evaluated at read time, so no `expired` event is emitted.

### terminalControl is not grantable in this slice

The runner terminal gateway is observe-only, so `terminalControl` is never granted: the device
record schema makes a control grant unrepresentable, and accepting it at completion returns 403
`terminal_control_not_grantable` **without consuming the completion token**, so the device retries
with Supervise. The grant→scope mapping (`terminalObserve`→`observe`, `terminalControl`→`control`,
per ADR 0033) is documented at the seam but not wired; the runner keeps its own per-process
authority.

## Alternatives considered

- **Generalize `CapabilityTokenIssuer`** (`@clankie/credential-broker`) for device sessions —
  rejected because it caps grant lifetime at 15 minutes, correct for per-operation capability
  grants but wrong for day-long device sessions. A sibling signer keeps that invariant intact.
- **Store token hashes in device events / a revocation list** — rejected because it puts
  credential-adjacent material in the durable log and adds per-token state. Identity-only tokens
  plus a projection check give per-device revocation with no stored secrets.
- **Put grants in the token** — rejected because it makes "refresh cannot widen" and "revocation
  is immediate" enforcement obligations rather than structural facts.

## Consequences

- Rotating or deleting the signing key is the revoke-all lever; a control-plane restart invalidates
  in-flight (pre-completion) pairings but never durable device identities.
- The app persists only the identity token in the platform keychain and re-reads grants from
  `GET /v1/devices/self` on launch, so a grant reduction or revocation on the host takes effect on
  the device's next request or refresh.
- Relay-path device authentication, runner control-lease enforcement, and biometric re-lock remain
  out of scope here (VUH-870/730 and a later slice); this ADR governs identity, session, and grant
  issuance/revocation.
