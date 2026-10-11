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

The native proof is skipped in normal push/release checks. No evals, production
service restarts, credentials, accounts, or OS default/search-list configuration
were changed. Integration's exact-tree gate and confirmed push are the landing
requirements; local focused checks alone do not claim a landed result.
