# ADR 0063: A play request starts embodiment; the play host owns it

Status: accepted (2026-07-26). The original embodiment-manager and separate
play-host topology was later folded into the single Clankie service described by
the [current architecture](../architecture.md). The enduring decision is that
the captain requests play while the component holding the body lock validates
and executes it. Doctrine profiles, approval ceremonies, and mission machinery
mentioned in the historical rationale are no longer current systems.

## Context

"Hop in voice and play Pokemon" crosses presence, conversation, gameplay, and
rendering boundaries. The captain interprets the request, but it does not hold
the emulator body, possession lock, checkpoint store, or frame producer.

The cross-process body lock is the only authority that sees every possible
writer, including an external MCP possessor. A conversational tool therefore
cannot become a private path around that lock.

## Decision

The captain exposes `start_play` and `stop_play` for a catalogued environment.
It decides whether to ask; the service-owned play runner resolves the body,
validates the request, and reports what actually happened.

```mermaid
flowchart LR
  H[Operator or admitted room turn] --> C[Captain]
  C -->|start_play / stop_play| S[Clankie play runner]
  S --> L{Shared body lock}
  L -->|available| G[GBA session]
  L -->|held| R[Typed refusal]
  G --> A[Activity frame sink]
  G --> J[Journal + checkpoint]
  R --> C
```

- **Agent-owned intent.** No keyword matcher decides that a message means play.
  The captain chooses a typed capability from the conversation.
- **Host-grounded identity.** Actor and room come from authenticated turn
  context, not model arguments.
- **Body-owned execution.** The runner acquires the same cross-process lock used
  by possession. A collision returns a typed `body_held` result the captain can
  explain.
- **Bounded truth.** Startup waits only for a bounded started/refused result;
  after that bound the request remains pending rather than being guessed
  successful.
- **Session limits are explicit.** A request may carry turn or duration bounds.
  At ratification the owner's default was open-ended play until an explicit stop;
  body lock, pause-on-lease-lapse, checkpoints, and launcher stop were the
  standing controls.

At ratification `environment.play.start` and `.stop` were classified as
reversible writes by a doctrine/profile engine, and ambient requests could not
complete an approval ceremony. That machinery was removed. Its lasting design
constraint is that conversational intent does not bypass host-grounded identity,
body ownership, or stop controls.

## Alternatives considered

- **Let the captain process own the emulator directly** was rejected because it
  would move body and frame-producer authority into the conversational tool.
- **Run a permanently active player** was rejected because a play session is
  on-demand model work with an explicit stop.
- **Have the Discord bridge start gameplay** was rejected because gameplay is an
  ability shared by text, voice, and operator surfaces, not a gateway effect.
- **Represent play as a mission plan** was rejected in the retired mission
  architecture because task-graph ceremony did not model a lease on a body.
- **Add another RPC** was rejected because the owning service already carries
  the request.

## Consequences

- Replies reflect a real start, refusal, or pending request rather than intent.
- All callers converge on one body-lock refusal regardless of which process
  currently holds the emulator.
- Presence, activity rendering, narration, and play lifecycle remain separate
  capabilities that compose around the body.
- Current commands, tool semantics, possession, and checkpoints belong in the
  [GBA MCP operating guide](../../apps/gba-mcp/README.md).
