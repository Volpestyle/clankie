# LOCAL-VUH-4: shared operator bearer boundary

Tracks: clankie-work://local/issue/bd3f2238-7e17-4dcd-a398-5670efa1a237

Baseline: fetched `origin/main` **103c96f4e82e6f40a75dddc879b7363b29166312**.
Owned worktree: `/Users/james/dev/clankie-wt/local-vuh-4-20261012`.
Project: `cbd205ab-cad4-48b8-9724-7109410fc921`.

**Outcome: vulnerability reproduced; full acceptance remains open.** No product
security fix is claimed. The diff documents the existing limitation in the CLI
and shipped work-items skill. No live owner action, credentials, settings,
accounts, evals, deployment or runtime restart was used for proof.

## Public-path scratch proof

The real source service and relay launched through both governed entrypoints
using one `scripts/scratch-stack.mjs` preset, private scratch state/settings/file
credentials and randomly generated scratch bearers. `NODE_ENV=test` and
`VITEST=true` isolated fixture resource state. Browser/Herdr were disabled;
model/provider credentials were absent. The paired app was created through the
real scratch pairing offer/redeem/complete API. The real owner loop raised
verification asks for three scratch items with real evidence-store records and
an independent scratch reviewer bundle check. Results were read back through
HTTP. Both owned service/relay processes were stopped after proof.

| Path                                                                  | Observed result                                    |
| --------------------------------------------------------------------- | -------------------------------------------------- |
| Missing/wrong credential: explicit owner tracker call                 | 401 `owner_required`                               |
| Missing/wrong credential: valid owner answer request                  | 401 `captain_authentication_required`              |
| Scratch captain bearer: explicit owner tracker call                   | 401 `owner_required`                               |
| Scratch captain bearer: valid owner answer request                    | 403 `question_owner_required`                      |
| Scratch paired terminalControl app: owner tracker read                | 200                                                |
| Scratch terminal: actual verification ask answer                      | 200; issue read back `owner-verified`              |
| Copied operator bearer with worker header: actual verification answer | 200; issue read back `owner-verified` (AC failure) |
| Scratch paired app: actual verification answer through relay          | 200; issue read back `owner-verified`              |
| Source `runWorkCommand`: `work owner get_issue`                       | `ok: true`                                         |
| Same CLI command/bearer with worker env markers                       | `ok: true` (AC failure)                            |

The positive terminal/app results establish retained behavior in **scratch**.
They do not establish that James alone can perform these actions. Worker labels
are attacker-controlled clues, not identities. No live worker/owner credential
was recovered or replayed. Distinct registered fleet admission was not exercised
by this proof; the reproduced bypass uses the shared operator credential from an
unrestricted shell. Lead and worker processes with that same bearer are
indistinguishable at this verifier.

Bounded setup/probe commands exited 0 for the final fresh-store proof. The two
server wrappers were deliberately interrupted after proof (exits 130 and 1);
both scratch listening ports were then confirmed closed. The archive retains
the observed tool session IDs, exits and cleanup checks as operator-recorded
provenance, not a cryptographic attestation.

```sh
clankie heavy -- pnpm install --offline --frozen-lockfile
node scripts/scratch-stack.mjs .local/owner-boundary-proof2
# Add NODE_ENV=test and VITEST=true to the private preset; never print it.
clankie heavy -- node --import ./apps/clankie/node_modules/tsx/dist/loader.mjs .local/owner-boundary-proof2/seed.ts
clankie heavy --server -- node scripts/scratch-stack.mjs run .local/owner-boundary-proof2 clankie
clankie heavy --server -- node scripts/scratch-stack.mjs run .local/owner-boundary-proof2 relay
clankie heavy -- node --import ./apps/clankie/node_modules/tsx/dist/loader.mjs .local/owner-boundary-proof2/probe.ts
```

The archived seed/probe scripts ran from `.local/owner-boundary-proof2`; their
relative imports assume that location. They read scratch secrets privately and
emit only status/error names and stage readbacks. The preset, credentials,
signing material and full service logs are excluded from this evidence bundle.

Three prior probe exits were 1: the first used malformed placeholder target IDs
and got 400 instead of the expected captain refusal; the second completed the
terminal answer but incorrectly checked outer `result.status` (`resolved`)
instead of `result.question.status` (`submitted`); the third saw no pending
terminal ask because that known-successful answer had resolved it. The corrected
probe passed once on a fresh preset/store. Those failures were probe errors,
not product refusal/positive evidence.

## Actual identity boundary and minimal plan

- [Operator authenticator](../../../apps/clankie/src/operator-auth.ts) maps every
  matching operator bearer to the same configured operator identity.
- [Owner authority and tracker routes](../../../apps/clankie/src/app/conversation-routes.ts)
  accept that bearer for `input_answer` and assign `TRACKER_OWNER` on the explicit
  owner call. The ordinary tracker call uses Clankie's agent actor.
- [CLI](../../../apps/tui/src/command/work.ts) resolves the same operator broker
  credential for `work owner` as ordinary work commands.
- [Broker](../../../packages/credential-broker/src/credential-store.ts) uses
  macOS `security(1)` or a same-user file. Device signing keys and service/state
  are also under the same user's control. These latter bypasses are source
  findings, not live exploits performed for this assignment.

[ADR 0253](../../adr/0253-owner-confirmation-needs-an-isolated-authority.md)
already states the missing security boundary. The minimum full-AC plan is to
put **every lead/worker shell** outside the owner OS principal using an enforced
restricted OS identity/sandbox, and protect owner credentials, device signing
and enrollment, local companion socket, verifier code and authoritative tracker
and ask effects/state from those shells. Preserve a trusted James terminal
channel and paired terminalControl app path. If the model-bearing service itself
remains agent-writable or executes owner-UID shells, a separate protected
owner-effect authority must own validation and effects; a middleware approval
boolean is insufficient. Fleet credentials should authenticate only delegated
agent operations. Test genuine protected terminal/app success and denied agent
calls, including enrollment/key/store/code bypass attempts, at that boundary.

Another env flag, secret name, same-UID helper, port or file mode does not meet
AC. OS/account/ACL setup and a broad authority migration require the lead's
scope decision and owner installation authority; neither was performed.
Both original acceptance criteria remain open. The lead owns scope and closure.
The global integrator owns the root exact-tree landing gate and landing.

The smallest next protected-authority slice can stay limited to Work: own
verification/reopen transitions, ask answers, their current revisions and replay
receipts, and the enrollment that authorizes those effects outside agent control.
Expose bounded agent writes separately. A trusted terminal confirmation and
paired app must submit an exact action proof to that authority; the shared
operator bearer must never satisfy it. Protect authoritative Work/ask state and
code as well as the signer. Owner-only setup is a reviewed signed installation
with OS authorization for the protected identity/ACLs, protected key enrollment
and migration of existing owner/device grants and authoritative records. James
must approve that setup; this documentation landing authorizes none of it.

## Independent native security review

The independent native reviewer inspected the docs diff, scripts, result rows,
real evidence fixture and scratch launcher. It confirmed the shared-bearer,
device-key, companion-socket and mutable verifier/state boundaries and found no
secret values in proposed tracked files. It accepted the docs and baseline
evidence with full AC open. Its correction to the blanket server exit-0 claim
is incorporated above. It did not rerun the proof; CLI owner coverage is a read,
and worker markers are not a distinct OS/fleet principal.

Evidence archive: [proof.json](clankie://evidence/sha256/e16224706be1ab79f487a38527738c6f3f09fa696a7a89f2be361c9b7aae3104).
