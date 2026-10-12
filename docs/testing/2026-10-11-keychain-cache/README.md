# Keychain cache and locked-keychain proof

Tracks: [VUH-2137](https://linear.app/vuhlp/issue/VUH-2137/service-floods-the-keychain-with-security-reads-when-its-locked).

The broker caches successful and missing Keychain entries across store instances,
coalesces concurrent reads, and checks secret-free account revisions. Broker
rotations/deletions invalidate that account in other processes; unrelated changes
and no-op OAuth checks retain cached entries. Cross-process I/O serialization is
separate from OAuth network/mutation locks. Native lock observation disables user
interaction, pins security commands to the observed keychain, and refuses locked
reads before spawning security. Native/CLI commands have three-second deadlines;
uncached read failures back off for 30 seconds. Doctor and public service health
expose one secret-free state. The service uses the existing durable owner-notice
path so the same incident appears in the app without a model turn.

## Real native evidence

The opt-in test created, populated, locked, unlocked, and deleted only an explicit
scratch keychain under a temporary HOME. It never selected, locked, unlocked, or
modified James's login keychain. A real HTTP listener used the production app and
credential-backed authenticator; unrelated captain behavior used the standard
fixture captain. The CLI proof called the production integrate command handler
with the explicitly scoped scratch store, rather than changing the OS default
keychain to run the installed executable. Actual spawned child PIDs and command
categories were recorded without arguments, credential values, or passwords.

- Ten simultaneous first reads: one security read; at most one measured child in flight.
- No-op update/updateMany checks and twenty authenticated HTTP requests: zero security reads.
- A separate Node process rotated the operator bearer: old HTTP bearer refused,
  replacement accepted after one new read. An unrelated provider write caused no
  operator re-read. Cross-process deletion then refused the cached bearer.
- A failed rotation while locked preserved the cached, unchanged bearer and cleared
  its pending publication; no security write ran.
- Twenty simultaneous cold reads across four accounts while locked: one native
  status check, zero security reads, one owner-state transition. The CLI handler
  also failed with “Keychain locked” and spawned zero security reads.
- Further reads and doctor during backoff: zero native/security children; doctor
  and `/health` both showed locked. After unlock and the real 30-second backoff,
  one new read cleared the state.

No security process was launched for locked read attempts, so those attempts
could not open security unlock dialogs, parallel or otherwise. The proof did not
induce the reported crashes or establish that their cause was the credential flood.
A lock occurring after the status check is bounded by the security deadline and
I/O lock; that race was not deliberately induced. Direct edits outside the broker
require a process restart. The separate manual eval helper's Claude subscription
lookup is outside this service/CLI broker path; no eval or harness credential read
was run here.

## Checks

Native proof: 1 passed, about 34 seconds including the real backoff. Focused broker,
auth, provider, Google account consumer, doctor, and owner-notice checks: 75 passed,
1 existing live-keychain smoke skipped. Broker, service, and TUI typechecks passed;
the affected service test partition was rechecked after final changes. Deadcode
and focused lint passed. Touched source/docs were formatted with Oxfmt and the
native helper with Ruff. Raw results and source hashes are in the evidence bundle.

Reproduce the native proof manually (only this file, never a full suite with the
live-keychain flag):

```sh
CLANKIE_KEYCHAIN_TESTS=1 clankie heavy -- pnpm exec vitest run apps/clankie/test/keychain-cache-native.integration.test.ts
```

The native proof is skipped in normal push/release checks. No evals, production service restarts, or account changes occurred. No OS default
or search-list selection command was issued; create/delete managed only the scratch
keychain. Integration's exact-tree gate and confirmed push are the landing
requirements; local focused checks alone do not claim a landed result.

## Consumer reconciliation

Fresh main added joined-seat routing. The channel could delete a revoked join
lease before the next launch observed the home refusal, causing a local operator
fallback. Revocation now publishes a secret-free refusal marker before deleting the
lease; a fresh broker instance reports `revoked`, and explicit leave clears it.
The joined-seat check waits for channel revocation before attempting its launch.

The harness dry-run fixture now selects a temporary credential file explicitly.
Its HOME alone never selected an isolated macOS keychain, and the new joined
lookup exposed that host dependency. Production locked-keychain failures remain
visible; they are not swallowed to make dry-run pass.

## Broad seat consumer check

After the seat-command gate failure, the full `apps/tui/test` directory and all
45 Clankie joined/seat test files were run locally. The broader check exposed
missing credential-file selection in the Codex, OpenCode, hosted, seat isolation
and explicit-resume fixtures. Each now uses a temporary file. The retained tool
render golden also selects its Unicode terminal capability explicitly instead of
depending on the runner's TERM. Assertions and timeouts are unchanged.

- Full TUI: 154 files passed, one existing file skipped; 1,240 tests passed,
  three existing tests skipped, 71.34 seconds.
- Clankie joined/seat: 45 files and 458 tests passed, 39.19 seconds.
- Formatter and lint passed for all seven changed test files.
- The cache and native lock helper are unchanged; their scratch-keychain proof
  remains the evidence for native process counts and locked-keychain recovery.
