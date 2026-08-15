# ADR 0051: Character, operating contract, and register are separate layers

Status: accepted (2026-07-25).

## Context

Clankie's owner-authored character and repository-authored operating contract
serve different purposes. The same person participates in operator work,
Discord rooms, and gameplay, while each surface needs its own speaking register.

The naive fix — writing a personality into the authored instructions — fails for
two reasons. It would make him informal in mission threads where precision is
the product, and it would place character in the same file as the operating
contract, so editing one risks the other.

## Decision

Identity is three layers with different lifetimes and different owners.

| Layer                  | Holds                                        | Varies by surface | Owner             |
| ---------------------- | -------------------------------------------- | ----------------- | ----------------- |
| **Character**          | name, aliases, humor, disposition, interests | no                | the human owner   |
| **Operating contract** | mission doctrine, evidence rules, escalation | no                | the repository    |
| **Register**           | how he speaks in the room he is currently in | **yes**           | derived from lane |

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

This is load-bearing rather than decorative. A warm, agreeable, eager-to-please
persona is precisely the thing that can be talked into privileged action — "sure,
I'll deploy that for you" is a plausible sentence for a character designed to be
helpful and chill. The persona layer therefore states plainly that being asked
warmly is not an approval, and every authority check remains exactly where it
is: ambient input still cannot approve privileged work (ADR 0045), and
privileged actions still route through the policy engine and the authenticated
surface.

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

An external harness can drive Clankie over MCP — playing, listening to the voice
channel, and injecting speech. A raw `speak(text)` tool would route
around this ADR's central property: persona is owner-authored and never supplied
by the caller, so that caller-controlled context cannot redefine who Clankie is.
A guest process's system prompt would become Clankie's voice in a room whose
participants consented to something else.

The decision, ruled by the owner, is that **a possessor does not inherit the
character and does not need to. The body, account, and bounds are Clankie's; the
decisions are the possessor's.** Possession is another mind driving, not a
costume it wears.

Persona therefore does not reach the possession path, and the MCP surface needs
no persona plumbing. The character applies only when Clankie owns the decision.

Whether the room learns that a guest is driving is a **separate question**. The
owner's rule is no in-channel disclosure.
Possession stays operator-visible through the lease transition log; the room is
not notified.

[ADR 0053](0053-mcp-possession-of-clankies-body.md) is authoritative for
possession and records that decision, its reasoning, its residual risk — a
possessor both speaks and listens, so participants are addressed and overheard
by a party they cannot detect — and the conditions that should reopen it. This
ADR deliberately does not restate any of it, so the two cannot drift apart.

What belongs here is only the character consequence, and it is a limit worth
stating plainly: for verbatim speech the code cannot make the words sound like
anyone, because the possessor authors them. Character consistency under possession
is a discipline a harness may choose to keep, never an invariant this repository
enforces.

Two constraints follow, both assigned to the implementing ADR to
specify in detail:

- **An MCP possessor is a new principal class.** It attaches to neither the
  ambient tier nor the voice presence tier. [ADR 0050](0050-voice-presence-authority-tier.md)
  is the precedent for adding one properly: a separate named policy, denied by
  default, reachable only by writing the open value exactly.
- **A listen tool is a new egress path** for private conversation into a guest
  process. It must sit strictly downstream of `/clankie voice-consent` and expose
  only consented, already-transcribed text. Raw and generated PCM are
  memory-only and zeroed after use (ADR 0045); a transcript tool must not
  become the reason that stops being true.

### Reply policy

`persona.replyPolicy` decides what earns a reply in an admitted text channel:

- `addressed` (default) — an `@mention`, or a message using one of his names.
- `all` — every admitted message.

`addressed` is the default because ADR 0045's channel allowlist treats an
empty list as "every channel in the allowlisted guilds". Without a trigger
policy, that combination makes Clankie reply to every message in the server.

The policy is evaluated in `refusalReason`, **before** the captain turn. Deciding
to stay quiet must not cost a model call, or an open channel allowlist bills a
turn for every message in every channel. Name matching requires a word boundary
so "clankiest" and `github.com/clankieproject` do not summon him.

## Options weighed

- **Write the personality into `instructions.md`** — rejected. It couples
  character to the operating contract and makes him informal in mission threads.
- **Pass persona through channel metadata** — rejected. Caller-controlled
  context redefining identity is the same hole ceremony instructions close with
  HMAC verification.
- **A second agent definition for social surfaces** — rejected. Two definitions
  means two souls, two drift paths, and a character that contradicts itself
  across surfaces. `captainLaneInstructions` already asserts one agent across
  lanes.
- **Model-decided reply triggering** — rejected. Asking the captain
  whether to answer spends the turn the policy exists to avoid.
- **Generating a default personality when none is authored** — rejected. Taste
  belongs to the owner; a synthesized character would be both wrong and sticky.
- **Re-voicing possessed speech through the persona** — rejected by the owner. A
  possessor is itself, not Clankie; dressing its decisions in his character
  would misrepresent whose they are. What follows from that for the room is
  ADR 0053's to decide, not this document's.

## Consequences

- The pi captain reads `@clankie/settings` when it creates a session, so owner
  persona stays outside repository instructions and caller input.
- The Discord bridge reads reply policy from owner settings.
- `persona.chattiness` shapes reply length and eagerness. Proactive
  speech — speaking unprompted when a voice channel goes quiet — is deliberately
  **not** in this ADR. It needs an idle clock, cooldowns, and barge-in
  interaction, and it will consume this same setting when it lands.
- Register is presentation only. Any future change that lets a register alter
  what an action may do contradicts this ADR and must supersede it explicitly.
- Free play consumes the `gameplay` register through
  `integrations/gba-emulator`, which depends on `@clankie/settings`. Editing
  the character in the TUI changes how Clankie narrates a playthrough, with no
  code change and no second prompt to keep in sync.
