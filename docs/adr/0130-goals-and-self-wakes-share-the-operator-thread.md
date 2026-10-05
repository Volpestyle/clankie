# ADR 0130: Goals and self-wakes share the operator thread

Status: accepted (James, 2026-08-25). Extends
[ADR 0111](0111-a-console-process-starts-one-conversation.md) and
[ADR 0124](0124-one-self-has-many-local-threads.md).

## Input admission

A human send with automatic delivery steers into an autonomous turn only while
that turn's `invoke()` is in flight. A goal or wake merely queued on the FIFO
does not open a live lane. Explicit `steer` also joins active human turns;
explicit `queue` always waits for its own turn
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
  Idea[Clankie notices useful work] --> Proposal[inactive proposed goal]
  Proposal -->|owner confirms /goal accept| Goal[durable active goal]
  Owner[owner sets /goal objective] --> Goal
  Harness[native harness seat] --> Refused[service goals refused]
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

`create_goal` persists an inactive `proposed` goal. Only the owner's
`/goal accept` (API `accept_goal`) confirms it; `/goal <objective>` (API
`set_goal`) creates an active goal directly. Resume cannot accept a proposal.
The model can finish or block an active goal. Completion remains a model audit
against the fixed objective and concrete evidence; it is not a second model
pretending to be an independent verifier.

Activation must remain an explicit owner action. The dispatch endpoint currently
accepts the same captain bearer that the owner TUI uses for autonomy `set_goal`
and `accept_goal`; it does not distinguish a human command from a shell-capable
turn using that credential. Such a turn can therefore activate or accept a goal
through the API itself. [VUH-1676](https://linear.app/vuhlp/issue/VUH-1676)
separates model-tool proposals from activation and enforces budgets and native
seat refusal, but does not redesign this authentication boundary. A follow-up
must bind activation to an owner-authenticated action independently of the
machine execution credential before exclusive human confirmation is enforced.

Every service goal has a finite model-token budget, defaulting to 1,000,000.
The owner can override it with `/goal --tokens <positive integer> <objective>`.
Legacy goals without a budget receive the same default, retaining their recorded
usage; exhausted goals become `budget_limited` before admission. Usage is saved
as each provider response settles, including failed turns, retries and compaction.
An error or aborted response reporting zero tokens records zero usage, preserving
Pi's retries and the next owner turn. Zero usage on a successful response, or
negative, fractional or non-finite usage, remains unaccountable and stops the run.
Background cache warming is disabled during goal work because it bypasses that
accounting path. Reaching the budget
stops the run before another provider request or continuation. A request already
in flight can exceed the remaining budget; it is accounted before further work.
An autonomous response without usable token accounting stops as `usage_limited`.

Native harness MCP seats refuse `create_goal` with `native_goal_unsupported`.
Owner activation and resume also refuse while a native seat owns the conversation.
Restored or queued service goals pause when a native head is discovered, instead
of falling through to a second Pi lead. The native goal store remains separate:
local Codex goals can be observed, while Claude has no service goal bridge.
Routing service continuations as native wakes would repeatedly enqueue them on
delivery acknowledgment without a goal settlement or usage accounting contract.

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
  inactive proposals preserve personality without silently creating an endless job.
- A separate autonomous agent or transcript would split identity, ordering,
  steering, and audit history from the operator thread.

## Consequences

- Clankie can pursue approved work continuously, stop on a hard token budget,
  and wake himself later without polling continuously.
- The console may be closed while the service continues; reconnecting tails the
  same durable events.
- There is deliberately no recurring calendar grammar, multiple pending wakes,
  separate proposal registry, or independent completion judge. Those become justified
  only when one replaceable wake and one active goal stop being enough.
