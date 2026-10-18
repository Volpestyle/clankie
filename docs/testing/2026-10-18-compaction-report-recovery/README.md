# VUH-2463: queued reports recover after stalled compaction

Tracks: https://linear.app/vuhlp/issue/VUH-2463

The original conversation journal and retained receipts were inspected read-only.
Routing was correct. The active turn stalled during compaction at 13:54:34Z;
each queued turn resumed the same oversized Pi session. The two reports failed
before admission at 14:19:44Z and 14:24:46Z, leaving their delivery stage
`unavailable`. The watch wake was accepted at 13:53:38Z and failed in the same
compaction trap at 14:29:48Z. The reports were offered at 15:15:25Z. No original
lane, report or watch was changed or replayed.

The shared durable-session path now records a stalled-compaction marker in the
old session before aborting it. Its model-request function is fenced against
late continuation after preflight compaction. The next turn creates a fresh Pi
session with the existing bounded conversation-log projection. The old session,
original acceptance, failed turn and unread reports remain evidence.

## Disposable proof

`compaction-report-recovery.integration.test.ts` uses real Pi sessions, a local
HTTP provider, the conversation store, inbound receipts and an armed Herdr watch.
The native worker observation is a disposable runner fixture. No paid model or
installed runtime is used. A virtual clock advances the unchanged five-minute
watchdog; the report, watch and explicitly queued owner follow-up then drain in
under the five-second observation deadline. Operator, social continuation and Discord durable lane
namespaces recover; the recovered model requests include the retained owner
context, exclude the oversized session and never send the abandoned owner prompt.
The report advances to `responded` and stays unread for explicit acknowledgment.

- Recovery disabled: both original cases fail; no queued inputs drain.
- Recovery restored: all three cases pass.
- Compatibility: 62 tests pass across the regression, conversation driver,
  worker-lead integration and seat outbox.

These fixtures prove shared service-session recovery, not a live Discord mouth,
actual Herdr process, provider performance or deployment. Existing native delivery
paths and receipt fencing are unchanged. The lead owns deployment and closure.
The required root landing-gate result and exact checked SHA are reported on the
issue by the lead; its machine-readable record is `.local/landing-gate.json` in
the assignment worktree.

Decisive output (full logs retained in `.local/vuh-2463/` in the assignment worktree):

```text
Recovery disabled:
  FAIL operator drains a queued report, watch and owner input after abandoning stalled compaction
  FAIL discord_presence drains a queued report, watch and owner input after abandoning stalled compaction
  AssertionError: expected +0 to be 3
  Tests 2 failed (2)

Recovery restored:
  Test Files 1 passed (1)
  Tests 3 passed (3)

Compatibility:
  Test Files 4 passed (4)
  Tests 62 passed (62)
```
