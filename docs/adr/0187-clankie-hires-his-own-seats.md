# ADR 0187: Clankie hires his own seats

Status: accepted (2026-11-24). Amends the app repo's ADR 0013 ("compose is
hiring"): hiring is no longer only the operator's act. Builds on
[ADR 0185](0185-a-hire-may-name-its-model-and-effort.md) — a hire Clankie
makes may name its model and effort the same way — and shares the authority
gate of [ADR 0186](0186-a-discord-room-harvests-its-own-workers.md).

## Context

Clankie routes work to fleet seats, but every seat first had to be hired by
the operator from the compose page. Telling Clankie "do this with pi on a
strong model" stalled on a human round-trip: he could describe the hire he
wanted, or start a bare process over bash with `herdr agent start`, but the
latter lands a stranger — no persona, no bound conversation, no watch — which
the roster only notices on its next poll, and which bypasses the typed
failure outcomes the compose path gets.

## Decision

**The captain has a `hire_agent` tool, and it is the same hire the compose
page makes.** One `hireSeat` closure in the captain serves both the
`spawn_seat` service op and the tool: herdr starts the harness, and the seat
is adopted as a persona, bound to its conversation, and watched atomically
with its pane. There is no second hire path to drift.

- **Authority is the shell's authority.** Hiring starts a process on the
  operator's machine, so the tool exists exactly where a turn could already
  start one by shell: the operator lane, or a Discord room holding the
  authenticated machine-access grant — the same gate ADR 0186 gives
  `herdr_watch`. A lane without that grant never sees the tool; a tool list
  is a boundary, not a prompt instruction.
- **An autonomous turn proposes, never executes.** Following `create_goal`:
  a goal continuation or scheduled wake may ask for a hire conversationally,
  but the tool throws. Starting processes and spending model budget stays
  answerable to a live person.
- **Failure stays typed.** The tool returns the same `OperatorSeatSpawnResult`
  as the compose page — `unknown_directory`, `harness_unavailable`,
  `not_ready`, `herdr_unreachable` — so Clankie can say plainly why a hire
  did not happen instead of reading a shell's stderr.
- **Model and effort ride along.** The tool takes the optional `model` and
  `effort` of ADR 0185, spelled the harness's own way, with the same typed
  refusal for a harness that has no wired flag.

## Consequences

"Herdr leadership goes through bash + the herdr skill" keeps its two
exceptions named in one place: the completion wake (a shell wait cannot
resume a finished model turn) and hiring (a shell command cannot wire a
persona). Everything else — panes, sends, waits — stays on the CLI.

A hire Clankie makes is attributed to the conversation that asked for it and
appears in the same roster as an operator's hire; cleanup follows the
standing rule that only the creator closes a temporary worker. Giving rooms
_without_ the machine-access grant a way to request hires (a proposal the
operator approves) is a possible follow-up; it is not this decision.

## Amendment: he briefs what he hires

Accepted 2026-09-26 with [VUH-1373](https://linear.app/vuhlp/issue/VUH-1373).
A hired Herdr seat is not a Swarm actor, so a `swarm_send` to anything a hire
returns (persona, conversation) fails `stale_recipient`, and `herdr agent get`
does not know the terminal id the hire returns as its seatId. In model evals
every pi hire came up idle and stayed idle: the only lane into it, the seat's
conversation, was reachable from the operator's surfaces and not from his tools.

- `hire_agent` takes an optional `brief`, delivered as the seat's first prompt
  down that lane (the seat mailbox when a bridge is polling, else the pane),
  and reports whether it landed and whether the seat picked it up.
- `message_seat` sends a follow-up the same way, by seatId, personaId or
  conversationId — the third named exception above, for the same reason: a raw
  pane send skips the mailbox and the seat ledger, and nothing points him at it.
- `herdr_watch` accepts the seatId a hire returns.

Swarm stays the path for enrolled peers; these reach only seats he can see.

## Startup readiness (VUH-1373)

A hire gives `herdr agent start` its explicit 30-second readiness deadline and
allows 35 seconds for the CLI process to return. Ordinary Herdr queries retain
their 5-second deadline. Applying that shorter query timeout to startup killed
the CLI while pi was still loading under CPU contention, then closed a healthy
worker's pane before its session report arrived.

After Herdr reports readiness, the existing bounded 10-second poll still requires
a durable session report before publishing the seat. This is the integration's
reported identity, not the existence of a transcript file: pi writes the file
when its first turn starts. A startup timeout or missing session remains the
protocol's typed `failed` / `not_ready` outcome with diagnostic detail, and closes
only the pane created by that hire. There is no second launch or blind retry.
