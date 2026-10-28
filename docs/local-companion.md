# Pair the companion on this Mac

The service and CLI provide a private local pairing handoff for the Mac
companion. Same-Mac route selection follows
[ADR 0204](adr/0204-a-self-hosted-mac-pairs-the-app-directly.md).
The native Mac app requests its first connection automatically, without a code
or CLI pre-step, through the service's owner-private Unix issuer. This API does
not install or launch the app.

The service publishes `companion-issuer.json` after its primary listener binds.
The state root must be canonical, owned by the current UID and not writable
by others; existing mode `0755` roots work. The companion directory is `0700`,
the descriptor and handoff files are `0600`, and the Unix socket is `0600`.
`CLANKIE_STATE` overrides the default `~/.clankie` root. The native app rejects
symlinks, foreign ownership, hard links and unsafe modes, validates the exact
socket path beneath that private directory, and checks its connected peer UID.

`POST /v1/pairing/local/handoff` exists only on this private Unix socket. It uses
the service's configured owner identity to mint a single-use offer and atomically
write `companion-offer.json`, replying only `{ "ready": true }`. No operator
bearer crosses this request and no TCP route exposes it. The existing
`clankie pair --local-companion --json` command remains available for older app
versions: it sends its operator bearer only to the validated private Unix issuer
and prints only `handoffPath`, never the offer. Do not run either owner handoff as
root or place its state in a shared folder. Same-user processes share the macOS
account boundary for this private issuer; the session itself goes only to a
trusted app (below). Loopback reachability or headers alone grant no authority.

The companion reads the same-UID file with no symlink following, verifies its
ownership, mode, size and expiry, then posts `{ "offerSecret": "…" }` to
`POST /v1/pairing/local/redeem` at its `controlPlaneUrl`.

Only an app the owner trusts can redeem
([ADR 0204, VUH-2604](adr/0204-a-self-hosted-mac-pairs-the-app-directly.md)).
The service finds the process holding the client end of the redeem's loopback
connection. It mints a session only when that process's running code satisfies
one of the owner's trusted code requirements. Trust an app with
`clankie companion trust /Applications/Clankie.app`.

- A Developer ID build is trusted by team and bundle id. The Mac app's id is
  `bot.clankie.mac`.
- An Apple Development build is trusted by bundle id and that certificate, so
  every later build with the same id signed by the same certificate is trusted
  too, from any checkout. A proof copy under another id is not.
- An ad-hoc build is trusted only by its exact code hash, so it is trusted again
  after each rebuild.

The list starts empty, and an empty list refuses every app. Any other app gets
`403 companion_app_untrusted` with a `reason` (`untrusted`, `not_signed` or
`peer_unknown`), and the offer stays valid for the trusted app. Each refusal is
recorded as `pairing.local_companion.refused` with the app's pid, identifier,
team, code hash and path. An accepted redeem records the same identity on its
`device.activated` or `device.session.refreshed` event. Proof builds for other
work pair through `clankie pair --purpose proof`; they are not trusted
companions. Use
`@clankie/protocol/local-companion` for the file, request and session schemas.
Remove the file after redemption. Keep the returned device token in the app's
credential store; restore and refresh through the existing device APIs.
A lost response must be reconciled with the app's stored session; a consumed
offer cannot be replayed. A newly requested private handoff can recover the same device. The Mac app
automatically renews lost or invalid private-local sessions once per restoration.
Explicit revocation asks once to connect again and creates a new identity;
remote sessions, host outages and rejected encrypted routes do not switch local.

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

Restoring with `GET /v1/devices/self` and refreshing with
`POST /v1/devices/self/session/refresh` over the primary native loopback listener
keep the service's loopback control/relay endpoints, even when the configured
direct route advertises a LAN or tailnet address for other devices. Headers do
not establish same-Mac provenance; forwarded gateway requests retain their
configured route. A successful private handoff and device reuse prove the
service boundary, not a fresh signed-app install.

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

## Joining another computer

Companion pairing makes a device portal on this Mac. `clankie join` registers a
machine where Clankie can act, with an outbound gateway connection and no SSH
route or inbound listener. The joining host generates a 256-bit approval code
locally and advertises only its hash; an existing owner
device approves its access level and a subset of its advertised directories.
The registry mints a separate `join-UUID` and scoped capability. These are not
device or operator credentials, and the client cannot approve itself. Approval
travels through the existing encrypted owner surface. The lease and channel
are independently authenticated and encrypted; the gateway cannot read or
forge commands, results or capabilities. Keep approval codes out of evidence.

Use `join --gateway URL --host HOST_ID --directory PATH`, `join approve CODE
--access LEVEL --directory PATH`, and `join resume|status|leave`; see
[the CLI guide](cli.md#join). Keep the joining terminal running. Leaving or
`machines remove join-UUID` revokes the capability; reconnecting needs fresh
approval. The receiver intersects current policy with its original approved
ceiling and canonical directory grants; raising the ceiling needs fresh approval.
Native worker/screen adapters and hosted gateway routing in `clankie-ops` are
named follow-ups; real Mac/Windows gateway captures are not yet verified.
