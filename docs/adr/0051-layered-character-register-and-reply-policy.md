# ADR 0051: Character, operating contract, and register are separate layers

Status: accepted (2026-07-25). The possession section is amended by
[ADR 0064](0064-possessor-voice-seam.md) and
[ADR 0074](0074-the-room-hears-one-voice.md): the possessor remains a distinct
inbound principal, but it no longer authors outbound room speech verbatim.

## Context

Clankie's owner-authored character and repository-authored operating contract
serve different purposes. The same person participates in operator work,
Discord rooms, and gameplay, while each surface needs its own speaking register.

The naive fix — writing a personality into the authored instructions — fails for
two reasons. It would make him informal in operator work where precision is
the product, and it would place character in the same file as the operating
contract, so editing one risks the other.

## Decision

Identity is three layers with different lifetimes and different owners.

| Layer                  | Holds                                           | Varies by surface | Owner             |
| ---------------------- | ----------------------------------------------- | ----------------- | ----------------- |
| **Character**          | name, aliases, humor, disposition, interests    | no                | the human owner   |
| **Operating contract** | repository rules, safety boundaries, escalation | no                | the repository    |
| **Register**           | how he speaks in the room he is currently in    | **yes**           | derived from lane |

One person in different rooms — not two bots, and not a personality that
dissolves the operating contract.

Character lives in `@clankie/settings` as `persona`, is edited from the TUI with
`/persona`, and is **authored by the owner**. The code carries a personality; it
never invents one. An empty `characterNotes` renders no character rather than a
generated stand-in.

Register is derived from the captain lane in
`apps/clankie/src/captain/captain.ts`:

| Lane                                | Register   |
| ----------------------------------- | ---------- |
| `operator`                          | `operator` |
| `discord_presence`, `discord_voice` | `social`   |
| `gameplay`                          | `gameplay` |

The lane comes from the authenticated channel address, so a message typed in
Discord cannot request the operator register — the same property ADR 0048 uses
to bind `transportKind` to authentication rather than to a request body.

Persona is read from the local owner-authored settings file rather than passed
through channel metadata, for the same reason ceremony instructions are
HMAC-verified: caller-controlled context must not be able to redefine who
Clankie is.

The pi system prompt composes repository instructions and owner-authored persona
at session creation. No caller controls either layer.

### Authority is not a register

Every rendered persona ends with an explicit invariant: voice changes with the
room, permission never does.

This is load-bearing rather than decorative. A warm, agreeable persona is
precisely the thing that can be talked into machine action. The persona layer
therefore states plainly that social agreement is not authority. Host-grounded
actor and lane checks remain outside the register; current Discord system-tool
authority is defined by
[ADR 0095](0095-discord-system-actors.md).

### The gameplay register has one intended consumer

The `gameplay` register exists because free play (ADR 0049) is a surface where
Clankie speaks — he plays and commentates, and that commentary is headed for a
Discord voice channel.

`free-play-mind.ts` calls a model with `FREE_PLAY_SYSTEM_PROMPT`, which describes
the surface but does not redefine identity. One character across surfaces is
the invariant.

The composition point is deliberately not captain-shaped.
`personaInstructions(persona, register)` and `characterNames(persona)` are pure
functions exported from `@clankie/settings`; any host can load owner settings
and render the character without a channel context or captain import. The pi
captain adds only the lane-to-register mapping. A standalone loop like free play
therefore reaches persona directly.

`FREE_PLAY_SYSTEM_PROMPT` describes the surface only, and
`createModelFreePlayMind` takes a separate
`character` option composed **before** the game rules:

```text
character (persona, gameplay register)   ← who is playing
FREE_PLAY_SYSTEM_PROMPT                  ← what this surface allows
systemSuffix                             ← transient operator context
```

Ordering is load-bearing. Character leads because it says who is playing;
putting the game prompt first makes it the primary identity again, which is
exactly the drift this layer exists to prevent.

`character` is deliberately **not** `systemSuffix`. That option carries
operator-injected mid-play context — a question asked during a run — which is
transient, while character is stable for the whole session. Overloading one slot
for both would tie a session-long property to a per-interjection channel.

Both the captain gameplay register and a standalone play host use the same
persona renderer, satisfying one definition of the character.

### Possession is a distinct principal, not a borrowed persona

An external harness can drive Clankie's body and hear admitted room input. The
body, account, and bounds are Clankie's; gameplay decisions are the possessor's.
Possession is another mind driving, not a costume, so the MCP process does not
receive persona plumbing or inherit captain authority.

That remains the inbound and control-side decision. The original outbound
consequence was later superseded. A possessor cannot inject a sentence for the
room to hear. Under [ADR 0064](0064-possessor-voice-seam.md) it reports an event,
and under [ADR 0074](0074-the-room-hears-one-voice.md) the realtime room session
is the sole author of the spoken words. Character consistency is therefore
enforced at the gateway-owning mouth without pretending the possessor made
Clankie's decision.

Whether the room learns that a guest is driving remains a separate disclosure
decision owned by [ADR 0053](0053-mcp-possession-of-clankies-body.md). Hearing
also remains downstream of voice consent: transcripts may cross the possessor
seam, raw audio may not.

### Reply policy

`persona.replyPolicy` decides what reaches the captain in an admitted text
channel. Reaching him is not an obligation to answer: the captain may return
the silent sentinel on every turn.

- `all` (default) — every admitted message reaches him and he decides whether
  to speak.
- `addressed` — an `@mention`, or a message using one of his names, reaches him.

`all` is the default because Clankie is the social agent, not the output of a
phrase gate. Guild/channel/DM admission still bounds what he may perceive.
Owners who prefer to avoid one model turn per admitted message can explicitly
choose `addressed`; that is a resource policy, not a substitute decision-maker.

The `addressed` policy is evaluated in `refusalReason`, before the captain turn,
because its purpose is to save that turn. Name matching requires a word
boundary so "clankiest" and `github.com/clankieproject` do not summon him.

## Options weighed

- **Write the personality into `instructions.md`** — rejected. It couples
  character to the operating contract and makes him informal in operator work.
- **Pass persona through channel metadata** — rejected. Caller-controlled
  context redefining identity is the same hole ceremony instructions close with
  HMAC verification.
- **A second agent definition for social surfaces** — rejected. Two definitions
  means two souls, two drift paths, and a character that contradicts itself
  across surfaces. `captainLaneInstructions` already asserts one agent across
  lanes.
- **A separate model-decided reply trigger** — rejected. The captain already
  decides speech versus silence; a second personality-free model duplicates him.
- **Generating a default personality when none is authored** — rejected. Taste
  belongs to the owner; a synthesized character would be both wrong and sticky.
- **Let the possessor author room speech verbatim** — the original consequence
  was superseded by ADR 0064/0074. The possessor now reports what happened and
  the room's realtime persona authors what is heard.

## Consequences

- The pi captain reads `@clankie/settings` when it creates a session, so owner
  persona stays outside repository instructions and caller input.
- The Discord bridge reads reply policy from owner settings.
- `persona.chattiness` shapes reply length and eagerness.
  [ADR 0057](0057-realtime-voice-with-captain-handoff.md) later used it to
  rate-limit offered unprompted voice turns.
- Register is presentation only. Any future change that lets a register alter
  what an action may do contradicts this ADR and must supersede it explicitly.
- Free play consumes the `gameplay` register through
  `integrations/gba-emulator`, which depends on `@clankie/settings`. Editing
  the character in the TUI changes how Clankie narrates a playthrough, with no
  code change and no second prompt to keep in sync.
