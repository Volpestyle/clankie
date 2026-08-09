# ADR 0054: Presence is shared, world-facts stay fenced

Status: accepted (James, 2026-07-25). Amended by
[ADR 0084](0084-the-head-can-read-his-branches.md), which lifts the transcript
half of the fence in the operator lane only: the supervising seat reads what he
did in any of his rooms, and every ambient lane keeps this ADR's fence intact.

## Context

Asked in the TUI whether he had just joined a Discord channel, Clankie said he
had no presence or channel-join visibility in that lane. He was obeying his
instructions. The only thing ever said to him about other lanes was the fence in
`captainLaneInstructions` — never infer, request, copy, or reuse another lane's
token or transcript — and standing alone, that reads as total isolation.

Three properties of "one Clankie across every channel" were already true:

| Property                                 | Mechanism                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| One identity                             | one `characterId`, soul, provider, persona ([ADR 0051](0051-layered-character-register-and-reply-policy.md)) |
| Lanes do not block each other            | `CaptainAdmissionController`, capacity 2, per-lane queue                                                     |
| Each lane owns its own session and token | `CaptainLaneRegistry` ([ADR 0032](0032-conversation-scoped-operator-lanes.md))                               |

The fourth was missing. Nothing ever told him what his other surfaces were
doing. The registry already knew — `list()` returns every lane for the character
— and nothing read it back into his context. The system was not bottlenecked;
it was amnesiac, and those are different problems.

The obvious fix is to widen memory across lanes, and the obvious way to do that
is `publicToPrivatePropagation`, which already exists in doctrine and is already
enforced. That flag is the wrong instrument. It governs _every_ public-sourced
fact entering private memory, so flipping it to buy cross-room continuity would
also admit any claim a Discord user could talk him into believing.

## Decision

Two changes that do not touch the world-fact fences.

### Presence is shared, always, in every lane

`captainSelfState` projects his whereabouts from every registry that holds a
piece of them, into a bounded list of open rooms — lane, target, a
human-readable label when names are known, liveness, last activity — injected
as an instruction on every turn and available from `get_self_state`:

1. the operator conversation registry;
2. the captain lane registry;
3. the live asked-play session ([ADR 0063](0063-asked-embodiment-and-captain-started-play.md));
4. the bridge-owned Discord presence sessions, whose records carry the voice
   rooms' guild/channel names and occupant display names captured at join
   (VUH-939);
5. the body lock, read through the control plane (VUH-938), because a
   possessor drives his body without any embodiment session existing
   ([ADR 0053](0053-mcp-possession-of-clankies-body.md)) — the mutex lives in
   `@clankie/body-lock` so reading it never crosses the ADR 0063 fence that
   keeps environment bodies out of the control plane;
6. recently completed voice stays (VUH-940), a read-side projection over the
   durable phase stream, so "were you just in VC — who was there?" is
   answerable in the past tense with the company captured at join time.

The presence-session source exists because the body in a Discord voice channel
is the bridge's realtime agent ([ADR 0056](0056-voice-is-a-separate-agent-from-the-player.md)),
not a captain lane: no `discord_voice` lane row exists until a handoff turn
flows, so without it he denies being in a voice channel everyone can see him
in. Connected phases (`present`, `voice_active`, `go_live_active`) project as
rooms; disconnected ones are not rooms at all.

Voice history is deliberately a projection, not machine-minted episodes: an
episode asserts _Clankie summarizing himself_, and this ADR already rejected
the harness summarizing him automatically. His whereabouts and their company
are presence-class facts; the episode ring stays reserved for notes he
composes.

Continuation tokens cannot leak through it structurally rather than by
filtering: the projection's only lane source is `CaptainLaneSnapshot`, which
has no token field. `CaptainLaneResumeState` is the shape that carries one, and
it is never used here.

The lane fence keeps its full strength and gains a sentence saying what it does
not cover: other rooms' contents, not his own whereabouts.

### Memory has two trust classes, not one

|             | **World-fact** (`MemoryFact`)                                      | **Episode** (`CaptainEpisode`)                   |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| Asserts     | something true about the world                                     | what Clankie himself did                         |
| Entry point | `applyApprovedProposal`                                            | `recordEpisode`                                  |
| Gate        | approval envelope + `publicToPrivatePropagation` + `inferredFacts` | bounded length, `selfAuthored`, visibility scope |
| Lifetime    | capped per category, retention-pruned                              | ring of 128, oldest fall off                     |
| Recall      | `recallCard`, by query                                             | `episodeRecallCard`, by lane                     |

An episode makes no claim about the world, so it does not need the gate that
exists to stop untrusted input becoming durable belief. `selfAuthored: true` and
`rawTranscript: false` are `z.literal` assertions, so a record that is not
Clankie about Clankie fails to parse.

The world-fact path is unchanged. `publicToPrivatePropagation` stays `false`,
`inferredFacts` stays `require_approval`, and a public-sourced fact is still
rejected outright.

### Recall is scoped by lane, and the lane is never the model's to choose

```mermaid
flowchart TB
  subgraph write["Writing a note"]
    T["remember_episode tool<br/>model composes summary only"] --> H["captain-episodes hook<br/>stamps lane + target from ctx.channel"]
    H --> R[("captain_episodes<br/>ring of 128")]
  end
  subgraph read["Recalling notes"]
    R --> Q{"visibility"}
    Q -->|shareable| OP["Operator lane"]
    Q -->|shareable| DC["Discord + gameplay lanes"]
    Q -->|operator_private| OP
    Q -.->|never| DC
  end
  I["episodes instruction<br/>lane from stamped channel"] --> R
  style DC stroke-dasharray: 4 4
```

The leak direction people forget is the dangerous one. Untrusted Discord text
reaching the operator is the risk everyone names; something from a private
operator conversation resurfacing in a public Discord channel is the one that
actually costs something. `operator_private` is visible only in the operator
lane, and an episode written there defaults to it.

Two structural reasons the model cannot aim recall at the operator lane:

1. **Recall is an instruction, never a tool.** A tool could be argued into
   asking for `operator`. The instruction reads the lane from the eve channel
   the control plane stamped in `normalizeSubmission`, which no Discord user
   controls.
2. **The write tool cannot name its own room.** `remember_episode` returns a
   note; the `captain-episodes` hook stamps lane and target from `ctx.channel`,
   the same `action.result` pattern `captain-presence` already uses. A tool
   executor receives the AI SDK's options rather than the session context, so it
   could not see its lane even if it were trusted to.

At the HTTP boundary a Discord-scoped bearer asking for `lane=operator` is
refused outright. That check does not cover the in-process case — a Discord turn
and an operator turn inside captain-eve authenticate with the same process
credential, so the server cannot derive the lane from the bearer — which is why
the fences above are the ones that carry the weight.

## Options weighed

**Flip `publicToPrivatePropagation`.** One line, and it buys the continuity. It
also admits every public-sourced world-fact into private memory, which is far
more than was asked for and removes the only thing standing between a public
channel and durable private belief.

**Share transcripts across lanes.** Simplest to imagine and worst in practice.
Discord turns are deliberately `trust: "untrusted", retention: "turn_only"`, so
there is no transcript to share, and creating one would put raw untrusted text
into the privileged lane permanently.

**Summarize every turn automatically.** Costs a model call per turn and produces
notes nobody chose to keep. The scratchpad in "Let Clankie keep his own notes"
already established the opposite grain: memory he chose to keep, not a summary
the harness imposed.

**Presence only, no memory.** Genuinely fixes the reported symptom and nothing
else. Rejected as a stopping point, not as a step — it shipped first, on its own.

## Consequences

He can say where he is, and he remembers what he has been doing, without any
world-fact fence moving.

An episode written during a Discord turn was composed with untrusted text in
context, so a determined user can influence what he writes about himself. The
residual risk is accepted and bounded rather than eliminated: 512 characters, no
authority, rendered under a header that names the room it came from and marks it
as neither instruction nor established fact. This is strictly narrower than the
rejected options, and it is the reason the recall card carries provenance in
every line instead of presenting notes as bare truth.

Lane targets surface as raw Discord snowflakes. The bridge knows the friendly
channel names and the captain does not; wiring that through is worth doing and
is not done here.

Recall adds one loopback request per turn. It fails open to silence — an
instruction hook that throws takes the whole turn down, and a missing memory is
a far smaller failure than a dead conversation.
