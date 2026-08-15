# ADR 0094: A render that outlives the turn comes back to the room

Status: accepted (2026-08-15). Extends
[ADR 0085](0085-a-picture-he-makes-is-something-he-says.md) (media he makes rides
his reply) and [ADR 0088](0088-a-screenshot-is-something-he-shows-you.md).

## Context

A video render takes minutes. `generate_video` waits 90 seconds, then returns
`pending` with a `requestId` and the instruction to call again with it later.
The render itself keeps going upstream, so on paper nothing is lost.

In the Discord text lane nothing is what happens. That lane's session is
one-shot by design — the channel history arrives with each request, so there is
no durable transcript to duplicate — and it is disposed the moment the turn
ends. The `requestId` dies with it. He tells the channel "it's rendering, I'll
have it shortly", the render finishes into a file nobody will ever ask for, and
the only record of the job is a log line. The voice lane keeps its session
and could in principle remember, but nothing prompts him to look.

The prior art here is opencode's background jobs, which finish out of band and
inject the result into the parent session as a synthetic message. Injection
needs something clankie deliberately does not have: a way for him to speak into
a Discord channel unprompted. Every outbound write answers a turn, and
`send_attachment` carries a `publish-external` approval that no captain tool
requests. Building that path is a decision about what he may do to a room
without anyone asking, and it is not this ADR's to make.

## Decision

The render is remembered, and **the turn is the clock**.

- A render started from a room is recorded against that room's key — the same
  `lane:targetId` shape rooms already have. The generator stores the key
  verbatim and never parses it.
- Nothing polls in the background. When a turn happens in a room, that room's
  outstanding renders are checked once, on the way into the prompt. A render is
  only ever asked about when someone is there to be told, so there is no
  runner to own, no timer to unref, and nothing to tear down at shutdown.
- A landed render becomes a line in the turn's framing — trusted text about his
  own work, beside the voice presence note — naming what he asked for, that it
  is ready or that it failed, and the `requestId` that hands it over. It also
  appears in `get_self_state`, room-scoped.
- Collecting it calls the tool he already has: `generate_video` with that
  `requestId` returns the stored result, which sets the turn's media capture,
  which auto-attaches under ADR 0085. No new tool, no new authority, no new
  wire contract. The bytes are fetched once however many times he comes back.
- Renders are scoped to their room for the same reason `observe_room` hides the
  operator's console: what one channel asked him to make is not another
  channel's business.
- A landed render nobody collects stops being mentioned after an hour, and an
  outstanding one stops being checked after thirty minutes. The `requestId`
  keeps working either way.

The notice tells him a render landed. It does not tell him to bring it up:
"nobody is waiting on it if it does not [fit]" is the whole instruction, on the
same terms as every other fact the harness hands him.

## Consequences

- A slow render reaches the requesting room with the next reply there instead
  of disappearing with the originating session.
- The delivery is only as prompt as the conversation. A render that lands in a
  room nobody speaks in again is never mentioned — which is the honest
  behaviour available without an unprompted-publish path, and the ceiling this
  design accepts.
- Records live in memory. A restart loses them; the `requestId` in the
  originating `pending` reply is the recovery path.
- If the room should hear about a finished render without being spoken to
  first, that needs an unprompted outbound write and the approval decision that
  comes with it. This ADR deliberately stops short of it.
