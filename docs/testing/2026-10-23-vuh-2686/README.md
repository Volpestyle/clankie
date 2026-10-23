# Stop settlement keeps a newer turn's hold

[VUH-2686](https://linear.app/vuhlp/issue/VUH-2686)

The service captures both the worker mailbox and conversation outbox before
requesting Stop. Each accepted activity observation and channel take advances a
monotonic revision. Settlement requires the same outbox instance and revision,
as well as the stopped session; a later turn cannot be marked waiting.

`seat-turn-hold.integration.test.ts` exercises real `SeatOutbox` queues and the
stdio channel pump. Both a native responding observation and a channel take in
the same session invalidate Stop's capture. A constant clock makes the two turns
indistinguishable by timestamp. Both queues stay held until the new turn ends,
and no waiting activity is published for the superseded Stop.

- `red.log`: the original `stopped-turn.ts` from `14cfeae8`, unchanged except
  for a signature adapter returning a closure, fails both new regressions
  (the queued message is delivered during the new turn). Its five existing cases pass.
- `green.log`: restoring the guarded implementation passes all seven cases,
  including the existing Claude adapter → watch → Stop → queue-release case.

Command: `clankie heavy -- pnpm exec vitest run apps/clankie/test/seat-turn-hold.integration.test.ts`.
This proves in-process settlement and channel delivery. It does not exercise
an app connection or a real Claude terminal.

## Recorded output

```text
v4.1.10 /Users/james/dev/wt-vuh2687

 ❯ |parallel| apps/clankie/test/seat-turn-hold.integration.test.ts (7 tests | 2 failed) 1543ms
   × Stop settlement preserves a newer observed turn and keeps its queued message held (VUH-2686) 205ms
   × Stop settlement preserves a newer taken turn and keeps its queued message held (VUH-2686) 206ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  13:55:43
   Duration  2.77s (transform 604ms, setup 31ms, import 1.08s, tests 1.55s, environment 0ms)

```
