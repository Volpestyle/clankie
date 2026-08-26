# ADR 0130: Goals and self-wakes share the operator thread

Status: accepted (James, 2026-08-25). Extends
[ADR 0111](0111-a-console-process-starts-one-conversation.md) and
[ADR 0124](0124-one-self-has-many-local-threads.md).

## Current status (2026-08-26)

A human send steers into an autonomous turn only while that turn's `invoke()`
is in flight. A goal or wake merely queued on the FIFO stays FIFO with every
other pair, including a later human send
([ADR 0091](0091-a-mid-turn-message-steers-the-turn.md)).

## Context

Clankie is always on, but a captain session only thinks when something wakes
it. Pokémon has its own play loop; general initiative needs a small durable
primitive without turning every observation into work or creating a second
agent beside the operator conversation. Clankie also needs room to propose
work he finds interesting while the owner retains authorship of active goals.

## Decision

Each operator conversation has at most one durable goal and one replaceable
self-wake. There is one global autonomy switch. The state lives in
`~/.clankie/captain/autonomy.json` and survives service and console restarts.
An unreadable state file fails closed and appears as `state_unreadable` instead
of silently re-enabling autonomy.

```mermaid
flowchart LR
  Idea[Clankie notices useful work] --> Proposal[ordinary conversation proposal]
  Proposal -->|owner activates /goal| Goal[durable active goal]
  Goal --> Queue[operator conversation queue]
  Wake[self-scheduled wake becomes due] --> Queue
  Human[operator message] --> Queue
  Queue --> Pi[same durable Pi session<br/>same tools and authority]
  Pi -->|verified| Complete[complete]
  Pi -->|cannot progress| Blocked[blocked]
  Pi -->|schedule_wake| Wake
  Pi -->|still active and within budget| Queue
  Off[/autonomy off] -. stops new autonomous turns .-> Goal
  Off -. stops wake timer .-> Wake
```

`create_goal`, `get_goal`, and `update_goal` follow Codex's behavioral split:
the owner or system activates a goal, while the model may only finish it or
mark it blocked. Autonomous turns cannot create a goal. Completion remains a
model audit against the fixed objective and concrete evidence; it is not a
second model pretending to be an independent verifier. A model-token budget is
optional and hard: reaching it moves the goal to `budget_limited` before
another continuation is admitted.

`schedule_wake(at, reason)` is available in operator turns. At the due time the
service queues one host-framed turn in that conversation. The reason is context
Clankie previously authored, not new owner authority. A wake can replace or
cancel the pending wake and can schedule its successor.

All autonomous work uses the existing conversation queue. A human message
therefore steers the same session and orders ahead of the next continuation
when it is already queued. A human message that arrives while the autonomous
run is still streaming is absorbed into that run
([ADR 0091](0091-a-mid-turn-message-steers-the-turn.md)) rather than waiting
for it to settle; an in-flight tool call still finishes. Waking grants no new
capabilities. Existing tool availability, owner confirmation rules for
destructive or far-reaching work, and external credential boundaries remain
the authority model. Turning autonomy off prevents new autonomous turns; it
does not abort a tool call already running.

## Alternatives considered

- A general planner, proposal database, policy engine, and multi-job scheduler
  add structure before there is evidence Clankie needs it.
- Letting Clankie activate his own goals removes the deliberate owner boundary;
  conversational proposals preserve personality without silently creating an
  endless job.
- A separate autonomous agent or transcript would split identity, ordering,
  steering, and audit history from the operator thread.

## Consequences

- Clankie can pursue approved work continuously, stop on a hard token budget,
  and wake himself later without polling continuously.
- The console may be closed while the service continues; reconnecting tails the
  same durable events.
- There is deliberately no recurring calendar grammar, multiple pending wakes,
  proposal registry, or independent completion judge. Those become justified
  only when one replaceable wake and one active goal stop being enough.
