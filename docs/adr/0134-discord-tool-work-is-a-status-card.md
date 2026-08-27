# ADR 0134: Discord tool work is a status card

Status: accepted (James, 2026-08-26). Extends
[ADR 0118](0118-a-text-room-is-a-durable-lane.md) and
[ADR 0024](0024-discord-dual-plane-presence.md).

## Context

Typing says Clankie is alive but not whether a slow turn is browsing, creating
media, or working locally. Posting one message per tool call would flood the
room, notify people repeatedly, and expose host details through tool names,
arguments, or results. Model-authored progress text is useful for social
updates, but it is not a reliable execution trace.

## Decision

An owner enables deterministic tool activity per guild channel with
`/clankie tools mode:on`; `off` and `status` use the same owner-only command.
The setting is persisted as `discord.toolProgressChannelIds` and is off by
default.

The captain host projects Pi's `tool_execution_start` and
`tool_execution_end` events into public-safe categories, counts, and elapsed
time. It never projects raw tool names, arguments, results, paths, queries, or
service payloads. Discord-social tools are omitted. The first write waits one
second so quick tool calls leave no card, later writes are throttled, and one
message is edited through running and terminal phases. A silent turn deletes
its card so silence remains a real answer.

The official bot renders the message as a quiet Components V2 Container with
an accent color and Text Display. The lab user-session body uses an edited
blockquote because user accounts do not own application components. The active
body mints and remembers the card message id; captain updates may edit or
delete only an id minted by that process.

```mermaid
sequenceDiagram
    participant P as Pi session
    participant C as Captain host
    participant B as Active Discord body
    participant R as Room
    P->>C: tool_execution_start
    Note over C: wait 1s; classify without content
    C->>B: running categories + counts
    B->>R: create one quiet status card
    P->>C: more tool start/end events
    C->>B: throttled aggregate update
    B->>R: edit the same card
    C->>B: completed / failed / dismissed
    B->>R: edit terminal state or delete for silence
```

## Consequences

- A room can see what kind of work is happening without receiving tool-call
  spam or host-sensitive details.
- Progress is host-authored evidence, separate from Clankie's voluntary
  `send_text_update` speech.
- The terminal card remains as a compact audit for spoken turns. It is not a
  transcript; detailed evidence stays in Pi's local session tree.
- The toggle applies to new turns. An in-flight turn keeps the visibility mode
  it started with.

## Options weighed

- **One Discord message per tool call.** Rejected because it is noisy and
  creates avoidable notification and rate-limit pressure.
- **Embed raw tool names or arguments.** Rejected because names and values can
  disclose paths, queries, connected services, and untrusted content.
- **Let the model narrate every tool event.** Rejected because deterministic
  lifecycle state belongs to the host; Clankie still decides when to speak.
