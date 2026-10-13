# 0269: Browser pairing binds an account session to one device

- Status: Accepted
- Work: VUH-2122, VUH-2123
- Builds on: [0268](0268-account-owned-device-revocation-survives-a-sleeping-body.md)

A signed-in browser is an owner device, with the same offered and accepted chat,
steer, terminal-observe and terminal-control grants as a paired phone. The UI's
lack of a terminal control does not confer extra authority. Pairing completion
remains the point at which access is accepted; reconnect is not a grant editor.

The fleet derives a session-family identifier and an authentication-event
identifier from **verified** Cognito access-token claims. Issuer, client,
subject, signature, token use and expiry are checked first. Configured web
clients without the required revocation claims fail closed. The identifiers
are hashes; the browser cannot supply a trusted account, tenant or device ID.

Under the account lock the fleet reserves one installation-bound browser device
for that session family. A signed, expiring, one-use ticket carries its device
ID and grant ceiling to the body. The public protocol owns this binding.
Reload and reconnect reuse it, including pending retries. An active reconnect
must preserve the exact previously accepted grants. The client may present its
saved ID only as an expectation: a mismatch cannot adopt another device.

```mermaid
sequenceDiagram
    participant Browser
    participant Fleet
    participant Body
    participant Phone
    Browser->>Fleet: Verified account token + expected device ID
    Fleet->>Fleet: Check session fence; reserve stable device
    Fleet->>Body: Signed one-use ticket with binding
    Body-->>Browser: Authenticated encrypted offer
    Browser->>Body: Redeem; accept offered grants
    Body->>Fleet: Declare device + accepted grants
    Fleet->>Fleet: Atomically check session and device revocation
    Body-->>Browser: Device credential
    Phone->>Body: Remove browser device
    Body->>Fleet: Durable tombstone + session-family fence
    Fleet-->>Body: Fresh signed revocation state
    Body-->>Browser: Dispatch refused; streams end
    Browser->>Fleet: Old account token / outstanding ticket
    Fleet-->>Browser: Refused until fresh interactive sign-in
```

Removing a browser device also fences its account session in durable fleet
state. Discovery, wake, offer and ticket issuance consult that fence, including
already-issued JWTs whose signature and expiry still pass. Body device
publication checks it atomically before issuing a credential. Active device
admission and stream checks use fresh, nonce-bound signed security state.
A sleeping body does not prevent account-owned revocation.

The dashboard's legacy ticket can hand off to a **phone**. It carries the issuing
browser session as authorization provenance, not as the phone's device identity.
That provenance survives offer redemption through completion, which checks the
same durable fence. Thus a ticket minted before removal cannot create an
unbound replacement afterward. Native owner-issued offers are unchanged.

Cognito JWT verification alone does not observe token revocation; see
[Token revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html).
The family uses `origin_jti`; the conservative authentication-event fence uses
verified `auth_time`. Unknown families from a revoked authentication event are
refused, while known other families remain usable. Authentication time is
second-granularity: a fresh sign-in in that same second may need to be repeated.
Missing or changed provider binding fails closed rather than silently registering
another browser. Live refresh rotation and independent-session behavior require
owner-controlled Cognito verification before production rollout (VUH-2123/2218).
Local signed-provider fixtures prove our enforcement, not live provider behavior.

No credentials or pairing capabilities belong in logs, screenshots, public
contracts or issue attachments. This change does not deploy the private fleet.
