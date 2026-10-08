# Native resource holders and independent budgets

Issues: [VUH-1858](https://linear.app/vuhlp/issue/VUH-1858) and
[VUH-1862](https://linear.app/vuhlp/issue/VUH-1862).

Baseline: `97a4e0566fda768abd35caac00168cc783256326`, verified clean and equal
to fetched `origin/main` before edits. Related landings inspected:
`b9ad0a20` (simulator reuse) and `54ef44f8` (lock-wait evidence).

## Cause and change

- Simulator ownership and in-flight acquire deduplication used fleet, seat and
  root occupant only. Native children share all three, so the second child got
  the first child's pending or held lease. An optional `holderId` now joins
  that key and the touch/release comparisons, and persists in the journal and
  public status. Old unlabelled journal claims retain root ownership.
- Claude's operator and worker Bash hooks use native `session_id` and `agent_id`
  to export `CLANKIE_RESOURCE_HOLDER` for that invocation. The hook preserves
  the other tool inputs and does not set a permission decision. It never writes
  a shared environment file. Codex uses `CODEX_THREAD_ID`; other harnesses can
  provide a stable explicit holder. These labels do not grant seat authority:
  the original occupant, live processes and binding remain host-proven.
- Heavy admission and status used the length of all leases. They now count
  only heavy leases. Simulator admission uses only the simulator limit, including
  external active devices. Status reports `capacity.used` for heavy leases and
  `capacity.simulatorUsed` for simulator reservations; simulator status separately
  reports external devices. Load and available-memory guards still gate both.
- Heavy leases and queue entries retain each child's label. A different supplied
  holder cannot reuse the parent’s inherited heavy permit, even in its process group. TUI status and doctor
  name it alongside the seat and show both budgets. The CLI, package reference
  and shipped fleet-resources skill describe the same contract.

The hook follows the native [Claude hook contract](https://code.claude.com/docs/en/hooks):
`agent_id` distinguishes child calls and `updatedInput` preserves unchanged fields.
Worker manifests are bumped to `0.6.10`, and the operator manifest to `0.3.2`,
so a later authorized install can refresh native caches.

## Verification

The final focused command, run through `clankie heavy`, passed 64 tests across four
files in 66.59 seconds:

- `packages/fleet-resources/test/heavy-process.integration.test.ts`
- `packages/fleet-resources/test/simulators.integration.test.ts`
- `apps/clankie/test/fleet-resource-routes.integration.test.ts`
- `apps/tui/test/fleet-resources-cli.integration.test.ts`

The tests use concurrent HTTP calls, a real durable registry with OS locks,
observed live owner processes, actual CLI/hook subprocesses and heavy runners.
The existing simulator fixture crosses a subprocess and filesystem receipt
boundary; it does not invoke live CoreSimulator.

Observed acceptance evidence:

- Two child identities under one seat produce one acquired lease and one waiter;
  the blocker and fleet status name the winning child. Acquire remains idempotent
  for that holder across manager restart. A sibling's touch/release is refused.
- Registered operator and worker Claude hooks carry distinct child IDs through
  shell execution, CLI environment selection, authenticated HTTP, verified seat
  proof, protocol validation and journal status.
- Real heavy CLI processes in one pane show distinct holder labels on the active
  lease and FIFO waiter. An empty explicit identity fails closed.
- Two actual heavy runners remain admitted while a simulator acquires its own
  slot. Conversely, heavy work runs while a simulator stays leased. Status shows
  two of two heavy slots and one of one simulator slots, then zero heavy and one
  simulator after the builds finish. An additional simulator waits.
- A different child in a registered heavy process group queues for a separate
  permit rather than inheriting the parent’s; cancellation removes its ticket.
  Existing same-holder nested command and signal/exit tests remain covered.
- High load refuses simulator admission and keeps a concurrent heavy request
  queued; both proceed after the isolated fixture's load drops.

Landing verification: `clankie heavy -- pnpm check:landing` passed at
`c4f0728e6` (implementation `ec711131`), based on fetched `origin/main` at
`4bf09369`. It passed formatting, lint, dead-code checks, docs, all typechecks,
and 6,305 tests in 665 files; 55 tests in 20 files were skipped. The test phase
finished in 565.87 seconds. See the [gate summary](evidence/landing-summary.log).

The final rebase onto `5aaa9342d` preserved every resource implementation and
covering-test file byte for byte. The landed implementation is `30c9147c5`, with
the harness-version assertion in `e20c89b3c`. The intervening main changes concern
worker refresh ownership and waiting-message visibility; only separate sections
of `docs/cli.md` overlapped. No source conflict or resource change was introduced
by that rebase.

Earlier gate attempts exposed the old shared-pool assertion and a harness-version
assertion pinned to `0.6.9`. Both were updated to match the delivered behavior,
and are covered by the final passing gate. The first shared-pool stop followed
3,639 passing tests; the version stop followed 5,059 passing tests. The final
focused 64-test run also covers preserved heavy FIFO order and independent
simulator admission.

## Scope

No live policy setting, unrelated job or lease was changed. No live simulator
was booted, no native agent was hired, and no deploy, runtime refresh or release
was performed. The automatic hook was tested as a real command with native-shaped
event input, not in a new live Claude session. Running installations adopt this
behavior only after a separate deployment/plugin refresh.
