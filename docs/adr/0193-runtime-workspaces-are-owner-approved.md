# ADR 0193: Runtime workspaces are owner-approved

Status: Accepted. Tracks [VUH-1377](https://linear.app/vuhlp/issue/VUH-1377).

## Context

The first native Claude lead used the global conversation rooted at the owner's
home. Herdr routes matched only that conversation directory and also launched
workers there. Dispatching to the real project returned only `reasons: ["worktree"]`.
Writing a different directory in the objective hid the mismatch without fixing
execution identity. Prefix acceptance beneath home would authorize unrelated
projects, while an exact-checkout-only policy would reject new Git worktrees.

## Decision

The operator configures extra workspace identities on each runtime through the
existing authenticated connection API, CLI and TUI. Repository entries store a
canonical Git common directory. Before dispatch the coordinator enumerates its
registered worktrees and verifies their repository identity, including linked
worktrees created outside the original checkout directory. Stale entries grant
nothing and are reported in rejection diagnostics without blocking valid routes. Non-Git directories
use exact canonical identities. The conversation directory remains the default;
no parent-directory prefix grants execution. A runtime retains one capacity pool.

The task's actual `contract.worktree` selects an eligible checkout. Canonical
selection does not rewrite the immutable intent or retry fingerprint. The worker
starts and enrolls in that directory. Its coordination scope remains the requester's,
while its file-reservation repository identity follows the selected repository.
Instruction snapshots still come from the selected Clankie conversation (ADR 0181).

Only the operator endpoint changes approvals. Swarm tools and captain/Discord
credentials cannot widen them; machine-granted dispatch undergoes the same route
checks. Existing grants of operator-machine shell authority remain unchanged:
this policy is not an OS filesystem sandbox.

Blocked selection reports the requested canonical path and each same-scope route's
allowed directories and reasons. It does not expose other coordination scopes.
The provider rechecks membership before launch. Approval changes affect new work;
existing intents retain their tokens, runtime fingerprints and receipts and can
still reconcile after approval is removed. No configuration edit restarts a worker.
Older owners must be deliberately upgraded before accepting the new policy.

## Capacity

Dispatch budget and each runtime capacity default to 16. The owner can change either:
`clankie runtime capacity ID N` sets a runtime limit and `clankie runtime budget N`
sets the overall budget. Replace `N` with `--clear` for unlimited; `0`
pauses new admission. The TUI accepts the same arguments after `/runtime`.
Both counts apply per coordinator scope, including runtime capacity: two
coordinators sharing one Herdr runtime can together exceed its configured limit.
Settings are reconciled into existing owners without replacing in-flight receipts.
`runtime status` reports each effective value and its source: default, owner or unlimited.
These controls use the operator API; no Swarm tool or captain bearer can change them.

`null` represents unlimited in settings and owner configuration; there is no
large sentinel value and no artificial numeric ceiling. Reducing a limit does
not cancel existing work. The lead chooses fleet size using current machine load.

## Verification

Coordinator tests cover registered linked worktrees, exact-directory rejection,
shared capacity, selected launch/enrollment paths, retained scope, file-reservation
identity and recovery of existing work after approval removal. API/CLI tests cover
canonical configuration, persistence, invalid paths, operator admission and refusal
of Discord/captain credentials. Live native-seat validation requires the launch
lead's coordinated restart window; isolated tests do not establish that live proof.
