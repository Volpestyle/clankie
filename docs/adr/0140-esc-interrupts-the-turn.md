# 0140. Esc interrupts the turn

Accepted 2026-08-29.

## Context

Esc during a streaming operator turn used to "detach": the console stopped
watching, but the accepted turn kept running — the contract had no way to
cancel one, so detach was what was possible, not what was wanted. The result
was a trapdoor James hit twice in one day: a detached turn finishes silently,
and its reply sits invisible in the durable log until the next prompt or
room switch replays it. pi itself interrupts natively (`AgentSession.abort()`);
what was missing was a wire between the console's Esc and that method, because
Clankie's pi session lives inside the service behind the HTTP dispatch
contract.

## Decision

Esc interrupts. The operator conversation contract gains a `cancel` op
(`conversationId` + `runId`): the store aborts that run's signal, the captain's
runner forwards the abort to the conversation's pi session
(`lane.session.abort()`), and the run settles in the durable log as
`turn cancelled · operator_interrupt` — never `failed`, and the session
returns to `waiting`. Partial text pi produced before the abort still
publishes, so the transcript shows what he had said. A run still queued
behind another cancels without ever invoking the runner. Cancelling an
unknown or already settled run reports `cancelled: false`.

The console keeps observing while the interrupt is in flight ("Interrupting…"),
so the cancelled event lands in the transcript and the tail settles on it.
Detach survives only as the fallback: when the service cannot cancel (an older
build, or the run settled first), on a second Esc while an interrupt is
pending, and on console quit — quitting never kills his turn. Turn-shape
metrics record these runs with the existing `interrupted` outcome.

## Consequences

- Esc now means the same thing in Clankie as in pi and every local agent:
  stop what you're doing. The silent-detached-reply trapdoor is gone with it —
  an interrupted turn's ending is part of the transcript you're watching.
- A cancelled turn is a first-class outcome across surfaces: any client of
  the dispatch contract (relay devices under the `chat` grant included) can
  interrupt a run it has the id for.
- Interrupting a steer that was absorbed into a live run aborts that live
  run — one pi session per conversation means one stream to stop.
