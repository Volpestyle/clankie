# Stop settlement keeps the correct turn's hold

[VUH-2686](https://linear.app/vuhlp/issue/VUH-2686)

The service captures both the worker mailbox and conversation outbox before
requesting Stop. Settlement requires the same outbox instance, session and turn
generation. A new session, explicit UserPromptSubmit start or any channel take
advances that generation. Same-turn PostToolUse activity does not.

Seat-sync marks UserPromptSubmit with `turnStart: true` on the final upload page.
The service and native worker hook pass the start signal to their outboxes. Older
strict services receive a bounded retry without the marker; they do not acquire
the Stop race guard until updated. Channel takes include Steer, so any take in
the Stop window conservatively preserves its hold until a later turn-end sync
or expiry.

## Integration proof

The tests use real `SeatOutbox` queues and the stdio channel pump with a constant
clock. A newer native turn start and a bridge take in the same session both keep
queued input held until that new turn ends. A late PostToolUse goes through the
real seat-sync hook producer and published upload schema, then the outbox and
pump: settlement still publishes waiting and delivers queued input at once.
The existing Claude adapter → watch → Stop → queue-release case remains green.

```text
Original stopped-turn.ts from 14cfeae8, unchanged except a signature-only adapter:
  Tests  2 failed | 6 passed (8)
  Both newer-turn cases deliver "Wait for new turn" before the new turn ends.

Rejected broad guard reproduced by incrementing generation on every observeTurn:
  late PostToolUse test fails: waiting is never published, so input remains held.

Corrected implementation:
  clankie heavy -- pnpm exec vitest run apps/clankie/test/seat-turn-hold.integration.test.ts apps/tui/test/seat-sync.test.ts
  Test Files  2 passed (2)
  Tests  18 passed (18)
```

The hook tests also verify the explicit start marker, absence on tool progress,
and fallback to an older strict service. This proves in-process queue delivery
and the hook upload contract. It does not exercise a live app→Claude connection.
A tool-progress upload arriving only after settlement remains a separate existing
activity-ordering limitation; this regression concerns uploads during Stop.
