# Project hire precondition refusals and allocation recovery

The retained local allocation `53c816d5-7b24-4c04-9ab6-cc7eed96998a`
(Nell, VUH-1702) is `started: true`, unconfirmed, with no pane. Ada's PC
allocation `821646db-4a84-4c0c-8182-41d9450ae171` has no pane; Pell's
`0d6a568c-c69e-4c8e-b251-4d6a9af673fe` retains `pc/wJ:p2`.
These were inspected without rewriting live state.

The retained conversation timeline shows Nell's machine-pressure refusals at
2026-10-08 03:34:54Z and 03:38:01Z, a checkout refusal at 03:43:58Z, and
`start_unconfirmed` at 03:44:11Z. The current captain's checkout freshness guard
already precedes reservation. The checkout refusal alone therefore does not
establish when the retained allocation became started. The journal has no
creation timestamp to correlate that exact latch. The code defect is observable:
`admitProjectLaunch` called `ProjectHires.launch` during policy probes, while
`failed` releases only allocations that never started. Preparation and final
resource checks can still refuse after those probes and before pane creation.

## Reproduction and change

The regression uses a real bare Git origin, two real clones, a pushed main
advance, the production checkout verifier, and the persisted project ledger.
With the original ledger code at `f7616113`, a policy-admitted hire followed by
`Start checkout does not contain fetched origin/main` kept its original
allocation on retry. The regression failed on that reused ID. Its retained
local log is `.local/evidence/hire-baseline.txt` in the assigned worktree.

Policy checks now validate without setting `started`. The journal latches before
pane creation, before the external prepared launch policy, and before a remote
host launch commitment. Observing a pane also latches the allocation. Definite
prelaunch failures release; an uncertain native effect stays held, including a
lost create response with no known pane. The checkout validation remains intact.

## Operator recovery

After this code is deployed, use the operator CLI, supplying the allocation UUID
rather than a native receipt UUID:

```sh
clankie hire-receipt settle 53c816d5-7b24-4c04-9ab6-cc7eed96998a release-allocation
clankie hire-receipt settle 821646db-4a84-4c0c-8182-41d9450ae171 release-allocation
clankie hire-receipt settle 0d6a568c-c69e-4c8e-b251-4d6a9af673fe release-allocation
```

This goes through the existing authenticated operator API. It refuses active or
confirmed allocations, an unavailable census, a still-present original pane or
worker in the directory, and any unresolved native hire receipt for the same
fleet/directory. Settle that original receipt with its existing appropriate
native disposition first. Ada's retained fresh intent is
`03fee986-a3c4-4501-a3bf-6cc4d8e34791`; its predecessor is
`719dd6b1-2814-4c2b-9eb6-118fb785427c`. Inspect their existing receipt evidence
rather than guessing a no-launch disposition. If Pell's pane remains present,
retain its work/session/handoff, settle uncertain reports, and explicitly retire
it before releasing the project allocation. This command closes no panes.

The release checks a snapshot again after inventory and authority checks, keeps
the original started/pane history, and records an operator release timestamp and
inventory digest. Repeating it reads the retained release without writing it
again. It releases only the project claim; it makes no no-launch claim, sends no
report, clears no native receipt, and starts no replacement. A later hire is
separate authorized intent. Never edit runtime state files to bypass the fences.

## Verification

The final Git fixture uses a clean divergent start, so a future safe fast-forward
for behind-only checkouts cannot remove its refusal boundary. The real
Git/persisted-ledger regression also verifies that attempted launches
stay held, a changed allocation cannot be released from an old snapshot, and
operator release preserves launch history. The manual
`NATIVE_HIRE_ALLOCATION_FIXTURES=1` case uses an isolated real Herdr server and the
production CLI/API/captain path to check absent allocation recovery, repeated
reads, bad authentication, unavailable native inventory, a present pane, and a
confirmed allocation. It touches only its owned namespace.

Focused existing project-hire coverage passed: 52 tests, one existing/manual
case skipped. The separate native opt-in run passed both tests with no skips,
including the CLI/API/owned-Herdr recovery checks and the unresolved native
receipt fence. Its log is `.local/evidence/hire-native.txt`; the earlier
focused log is `.local/evidence/hire-fixed.txt`. Landing-gate results are
attached to VUH-1826 after landing.
No live stuck allocation was released here, and no existing pane, service or
runtime was restarted or deployed. A deployment is needed for the new API and
for new hires to use the corrected allocation lifecycle.
