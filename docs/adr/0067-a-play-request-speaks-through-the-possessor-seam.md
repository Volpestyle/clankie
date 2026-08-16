# ADR 0067: A play request speaks through the possessor seam

Status: accepted (2026-07-26). Connects:
[ADR 0063](0063-a-play-request-starts-embodiment.md) (the captain
starts a playthrough because someone asked),
[ADR 0064](0064-possessor-voice-seam.md) (a possessor reports what the body did
and the persona voices it), [ADR 0056](0056-voice-is-a-separate-agent-from-the-player.md)
(the half of him that talks is its own agent), and
[ADR 0051](0051-layered-character-register-and-reply-policy.md) (one
owner-authored character, in a register per surface). These boundaries remain
authoritative.

## Context

The product sentence is "hop in vc and play pokemon" — join, play, watch, hear
him react, stop. The play host owns the free-play loop and the activity
overlay. The Discord bridge owns the live voice session. The possessor seam is
the bounded transport between them.

`@clankie/possessor-voice` carries both directions. The play host reports
events; the bridge lets the realtime persona compose audible words. Room speech
enters the playthrough through `InterjectionQueue` at turn boundaries. The play
host never receives a Discord gateway or the authority to choose exact speech.

The production host and `free-play-cli.ts` compose the same capabilities:

- **Voice agent.** ADR 0056 exists because the player model, asked to choose
  an action and optionally a remark in one call, spoke at most once in sixteen
  turns — speech loses to the decision when it is a side field. Both hosts pass
  the voice agent through the same gate.
- **One character.** Both hosts load the owner-authored persona in the
  `gameplay` register and hand it to the player and voice agents.

## Decision

The production host composes persona, voice agent, and transport. A play request
speaks and hears through the ADR 0064 possessor seam. [ADR 0074](0074-the-room-hears-one-voice.md)
defines the outbound event contract: the play loop reports what happens and the
realtime session authors the words. This ADR remains authoritative for inbound
room speech.

![ADR 0067: A play request speaks through the possessor seam](../diagrams/0067-a-play-request-speaks-through-the-possessor-seam.jpg)

**Judgement and carriage are separate responsibilities.**
The voice agent decides _whether this moment is worth a remark_; the seam
_carries_ the remark to the room. Wiring only the seam would have delivered a
pipe with nothing in it, because ADR 0056 already measured that the player model
alone stays near-silent. Wiring only the agent would have produced good lines
that reached a text sidebar. The cost of the second model call is bounded by the
gate ADR 0056 already ships: voice is consulted only when something happened —
someone spoke, or the turn produced a thought or an observable change.

**One character, both agents.** The persona is loaded once per playthrough and
handed to the player and the voice alike, exactly as the dev alias does. Two
agents sharing one character is the point of ADR 0056; two agents inventing
their own would be the failure.

**Why the play host is a possessor.** The play host holds the body and the activity
producer credential, but no Discord gateway and therefore no live presence claim
— structurally the same position an MCP harness is in. ADR 0064's fence is
exactly right for it: it reports, and the process that holds the gateway decides
how he sounds. This also means asked play cannot be used to make Clankie say a
chosen sentence, which stays true by construction rather than by policy.

**Reply before aside.** Someone who spoke to him is owed the answer before an
unrelated remark about a desk.

**Voice feeds the same queue stdin does.** Hearing the room needed no second
path into the loop, and a supplied queue (the dev script) still works alongside.

### Degradation

Silence is a degraded mode of playing, never a reason not to play. This matches
the frame sink exactly: no credential, no bridge listening, or a rejected line
all leave the playthrough running and watchable. The first rejected line logs
once per session — a bridge that is down stays down, and a line per turn would
bury the playthrough in its own failure.

## Consequences

- The product sentence is true end to end: he joins, plays, is watchable, is
  audible, and stops when asked.
- People in the voice channel can talk to him mid-playthrough and be answered.
  ADR 0063's authority model is untouched: an interjection is something a person
  says, not an instruction, and it reaches the same non-privileged field as
  developer stdin.
- Enabling remains the operator's, and stays off by default:
  `possessorVoiceEnabled: true` in the operator settings' `discord` block (env
  `CLANKIE_POSSESSOR_VOICE_ENABLED=true` as the override) plus a live voice
  session, unchanged from ADR 0064 in authority. One switch governs both
  drivers, which is the point of not building a second path — and storing it
  means a bridge restart cannot silently mute his playthroughs.
- The play host takes dependencies on `@clankie/possessor-voice` and
  `@clankie/settings`. It gains no credential class of its own: the bearer is
  broker-resolved exactly as the activity producer bearer is.
- A playthrough costs up to two model calls per turn, gated
  by ADR 0056's has-something-to-consider check and by the rate gate itself:
  the consultation is skipped when nobody spoke and the cooldown could not let
  an aside through, so most turns inside the cooldown cost one call. That is
  the price of him being a character rather than a cursor, and it is bounded by
  the same budget and stop ask every playthrough already carries.
- `free-play-cli.ts` and the production host compose the same three things, so
  the dev alias remains the thin wrapper ADR 0063 defines.
- Nothing is queued on a dead session's behalf. The subscription is released and
  the client closed when the playthrough ends, so a finished session cannot hear
  a room it is not in.

## Alternatives considered

- **Carry the player's own `speak` field and skip the voice agent.** Rejected:
  ADR 0056 measures that field as near-silent, so the transport carries almost
  nothing and looks like a seam defect.
- **A presence-action path with a live claim, so the words are verbatim.**
  Rejected: it would make the play host able to put chosen sentences in Clankie's
  mouth, which ADR 0064 deliberately prevents. The persona composing is a
  feature.
- **Publish overlay text and let a viewer read it.** Rejected: text-only output
  leaves the body mute in a voice channel.
