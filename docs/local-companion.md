# Pair the companion on this Mac

The service and CLI provide the local pairing handoff for ADR 0226. The signed
app distribution and installer integration are separate work; this API does
not install or launch the app.

Run `clankie pair --local-companion --json` as the Mac owner after the service
starts. It starts or reuses the app relay, asks the service's owner-private Unix
socket for an operator-authorized offer, and writes it atomically to
`~/.clankie/companion/companion-offer.json` (`CLANKIE_STATE` overrides the root).
The state root must be canonical, owned by the current UID and not writable
by others; existing mode `0755` roots work. The companion directory is private
(`0700`), and the file is mode `0600`. The service publishes
`companion-issuer.json` in that same private directory after its primary
listener binds, pointing at its own Unix socket and loopback URL. The CLI
checks private discovery and same-UID socket ownership before sending its
operator bearer over IPC. It never sends that credential to a TCP listener
that another local user could impersonate. Output contains only `handoffPath`, never
the offer. Do not run the owner handoff as root or place it in a shared folder.

The companion reads the same-UID file with no symlink following, verifies its
ownership, mode, size and expiry, then posts `{ "offerSecret": "…" }` to
`POST /v1/pairing/local/redeem` at its `controlPlaneUrl`. Use
`@clankie/protocol/local-companion` for the file, request and session schemas.
Remove the file after redemption. Keep the returned device token in the app's
credential store; restore and refresh through the existing device APIs.
A lost response must be reconciled with the app's stored session; a consumed
offer cannot be replayed. A fresh owner handoff can recover the same device.

`POST /v1/pairing/local/offer` requires the operator bearer; it returns
`version`, `offerSecret`, and `expiresAt`. These offers expire after five
minutes and die with the service. Minting another invalidates the previous
local offer. Redeeming succeeds once; replay is `consumed` (409), and an unknown,
expired or superseded offer is `expired` (410). The session response uses the
existing device identity, grants and signer, plus the host name and explicit
loopback control/relay endpoints. First redemption activates Take Control;
later handoffs preserve the active companion's device ID and grants, including
after a service restart. Revocation stays effective: fresh authorized pairing
creates a new identity and never revives the revoked token.

Local pairing exists only on a self-hosted Mac. The primary listener checks the
actual local and remote socket addresses, numeric loopback Host, native JSON
request, and browser/forwarding headers. Origin, Referer, browser Fetch Site/Dest
and forwarding headers are refused. Node's native fetch adds only Fetch Mode
`cors`, which is allowed. A browser page cannot read the private offer, mint one,
or redeem it. Another local UID cannot read the handoff or obtain the owner
bearer. Loopback reachability alone grants nothing. Local offers are absent from
the generic offer store, public gateway and LAN device doorway, and carry no
short code, deep link or gateway publication. Pairing responses are `no-store`;
secrets never enter events or logs.

Read `/v1/captain/readiness` for setup state. The companion and console share
credentials and model selection; neither keeps a separate setup flag. Device
subscription sign-in and the first-run key-entry limit are documented in
[model keys](model-keys.md).
