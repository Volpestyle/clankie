# Native fixture admission — bounded source candidate

VUH-2307's first source slice admits one exact original host-side private Codex
subject to one single-use fixture `get_user` read, with a 60-second nonrenewing
deadline. GLOBAL must review the diff before landing. Original-session/LOCAL13
proof is separately held. These commands do not constitute that proof.

`host-seat/v1` binds the original controller/process lifetimes, native session,
occupant, project and actual workspace. It does **not** verify the native login
account. Native-account assurance requests refuse. Ancestry establishes only a
transport relationship, not an actor, account or explicit native turn.

## Authority and fixture separation

The original-facing LocalFleetLink admission route requires
`admittedProjectProof` and returns before generic application forwarding. It
does not use broad pane `validate()` as authority. The callback has a separate
loopback listener and `/v1/fixture-admission/verify` path; the fixture is not a
pane member. No new path can use `/v1/fleet/mcp`, the connected catalog, operator
bearers or provider dispatch.

The host pins its fixed source-built worker artifact, input hashes and native
helper at controller construction. This assumes the installation tree is trusted
at host construction, just like the host code itself; it is not OS attestation
against arbitrary same-UID file/process control. The requester cannot select an
artifact, expected digest, manifest, fixture executable, root or PID. Missing
artifacts at host construction refuse rather than hot-adopting later files.

The host mints the fixture-only capability into its new private file broker,
passes it over the child's stdin pipe and observes that actual child PID's
kernel lifetime. No caller PID is accepted. The callback requires the capability
and that actual fixture socket owner's lifetime, then independently re-proves
the original from host-held registry/project/native proof and the fixture's
full kernel observation. Worker/helper byte changes refuse. A signed verdict
binds one callback nonce, claim, receipt, request, subject and fixture.

Only the fixture's existing private builtin store is readable. The strict backend
entrypoint never initializes, seeds, rolls cycles, migrates, invokes custom
callbacks or enters ordinary dispatcher fallback. Setup may create finite test
data before issuance. `get_user` returns fixture data, not native-account proof.

Request identity is durably reserved under the host state root in
`fixture-admission-requests/index.json`, outside fixture roots, before dependent
issuance effects. A restarted host loads retained IDs as status-only and cannot
mint/adopt them again, including pending/lost replies. Binding mismatches and
missing/corrupt/unsafe prior indexes refuse. An interrupted writer lock is not
stolen; it prevents mutations while retained status remains readable. Capacity
is bounded (4096 records / 8 MB); exhaustion refuses without eviction. Status
absence/unavailability never proves `not_sent`.

The fixture performs original-controller claim validation before any receipt
write. Only a successful claim can create its single immutable receipt record;
denied same-UID/unknown-ticket requests cannot squat a slot or append journals.
Lost claim remains host-retained uncertainty; consume/read is never retried.

Claim/consume and durable tombstones serialize in the issuer process. Existing
in-process final fences remain. The host consume verdict and fixture read have
a cross-process observation gap: no atomic revocation, cancellation or
nonexecution guarantee is claimed. Lost replies retain the original IDs and
uncertainty; no request/consume/read is transparently repeated.

## Source preparation and CLI

Prepare source artifacts only under separately authorized setup/build scope:

```sh
clankie heavy -- node scripts/build-fleet-proof.mjs
clankie heavy -- node scripts/build-fixture-read.mjs
```

This slice uses `.local/fixture-read` source artifacts. Release packaging is not
added or claimed. Do not restart or relaunch an installed host or original to
load these files without the relevant later scope.

Proposed original use after separate real-proof clearance:

```sh
clankie fixture-admission request --request-id UUID --receipt-id UUID --assurance host-seat/v1
clankie fixture-admission status --request-id UUID
clankie fixture-admission revoke --ticket-id UUID --request-id UUID
```

Only those original-facing operations discover the current native local link.
The issuance response names the host-created fixture descriptor. Fixture use
requires that exact private input explicitly:

```sh
clankie fixture-admission read --fixture /PRIVATE_ROOT/fixture.json --ticket-id UUID --binding SHA256 --claim-id UUID --request-id UUID --receipt-id UUID
clankie fixture-admission read-status --fixture /PRIVATE_ROOT/fixture.json --ticket-id UUID --binding SHA256 --claim-id UUID --request-id UUID --receipt-id UUID
```

The fixture branch never discovers installed links or command defaults, accepts
no origin override and rejects redirects and 4310/4321. Unknown flags refuse.
Status never repeats a read. Issuer/fixture restart invalidates active authority;
no receipt absence authorizes replay. On close/revoke/expiry, stop only the exact owned child and wait for its
observed exit before removing that identity-pinned private root, including its
fixture-only credentials. Natural process disappearance alone is insufficient;
unknown/mismatched root/process ownership preserves the root. Host request
index/tombstones remain outside the removed root. Prior-host IDs do not authorize
scavenging old roots. The child receives only private HOME/config/state, with
no NODE_ENV override or inherited provider/operator/account credentials. No historical UNKNOWN receipts or original sessions may be inspected,
reconciled, abandoned, replayed or substituted through this feature.

## Final durability and shutdown fences

The request index directory is private (0700); the host state root only has to
be owned by this user and not group- or world-writable, so the default 0755
`~/.clankie` works. First use writes the empty index in a private staging
directory, renames it into place and syncs the opened, identity-validated state
root before dependent issuance. An interrupted first write leaves only staging,
which never held a record; the next start removes it when it contains nothing
but that empty index and its temporary files, and preserves and refuses anything
else. Deleting the whole published index directory is indistinguishable from
first use.
This is filesystem ordering, not an exercised power-failure guarantee. An unsafe,
missing or corrupt index never fails service startup: fixture admission refuses
with `fixture_index_unavailable` and its reason, and the service logs
`fixture_admission.unavailable`. The index is never reset to make it usable.

Failed issuance stays pending through owned-close and durable finalization, so
another issuance cannot replace its drain promise. A bootstrap that fails and
cannot prove its own child and root gone keeps that fence too. A revoked or
expired fixture blocks the next issuance until its child is verified gone, its
root removed and both outcomes durably recorded; a failed retirement holds the
fence until restart. Unproven cleanup keeps the
admission fence blocked and makes host close fail. The production shutdown chain
starts admission close promptly, awaits it before process observers or settled
exit, and reports unresolved cleanup as failure instead of swallowing it. This
source wiring is not a live installed-host shutdown proof.
