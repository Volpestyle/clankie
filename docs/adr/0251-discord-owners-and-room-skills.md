# ADR 0251: Discord servers have owners; rooms can grant skills

Status: Accepted (2026-10-07). Implements VUH-1831, extends VUH-1622,
and supersedes ADR 0133's trusted guild/channel machine grant.

## Decision

Each connected server has two choices: Clankie's role (Participant or Admin)
and owners (Just me, Everyone, or a Discord role). Just me is the default and
uses the configured owner identity. Admin describes what Clankie can manage;
it never makes the server's members owners. Fleet and tracking choices also live per guild in `discord.guilds`
(VUH-2554, 2026-10-20; ADR 0227). Raw IDs stay in Advanced.

Owners have machine authority. Everyone else has social tools. A room may add
a named skill through one choice, “This room can use: house hunting”. Skills
are instructions, not executable authority (ADR 0236): a grant resolves to a
service-owned capability adapter with a fixed tool schema. Unknown skills
fail closed. There is no tool-name list or arbitrary command in owner settings.

The first adapter wraps the existing house-hunting ledger and listing API.
It accepts structured operations, binds household storage on the host, and
never exposes bash, general filesystem access, credentials, fleet tools or
other skills. Non-machine sessions use an explicit tool allowlist that removes
builtins from the callable registry, including after loadout changes. The SDK
`noTools: "builtin"` setting alone only changes the initial active tools.
The service loads only the granted skill's instructions, with
guidance to use this adapter instead of the skill's shell examples.

Role membership is read through the authenticated Discord body, never taken
from a message or a caller's claimed roles. Failure to prove it is social.
Shared rooms are conservatively treated as containing non-owners unless the
entire server is explicitly owned by everyone or the body proves a private
channel's permissions admit only owners. Their context explicitly keeps work,
fleet and machine detail private, including when an owner asks there. Native
owner seats and global memory must not supply private context in such rooms.

Durable system authority keys include the ownership policy. Skill handoffs are
fresh Pi runs, so their exact grants never survive into another turn.
An owner's machine turn in a mixed room stays one-shot. Skill turns use Pi,
never an owner-native harness. Grants are checked again at execution; removing
a room grant cannot leave a warm session or queued turn with the old tools.

Owner outreach, relays, fleet projections and tracking require an owner-only
audience. Unknown audiences fail closed. Admin is not evidence that an existing
room is private. New managed rooms start private; Discord permission changes
must be checked at delivery. Owner DMs retain the official-bot private boundary;
lab group DMs do not.

```mermaid
flowchart TD
    Turn[Authenticated Discord turn] --> Owner{Owner in this server?}
    Owner --> Audience{Every reader an owner?}
    Audience -- yes --> Work[Private work context and machine tools]
    Audience -- no --> Mixed[One-shot tools; private details withheld]
    Owner -- no --> Grant{Room grants a known skill?}
    Grant -- yes --> Skill[Social tools plus bounded skill adapter]
    Grant -- no --> Social[Social tools]
    Outreach[Owner outreach] --> Private{Owner-only audience proven?}
    Private -- yes --> Send[Deliver]
    Private -- no --> Refuse[Refuse delivery]
```

## Owner-directed room turns, 2026-10-21

James asked Clankie to post a clip in a shared channel he had never talked in
(VUH-2581): "u should just be able to post, no?" `room_turn` refused for two
reasons. It needed an existing room conversation. And since this ADR it ran
every fork with machine tools and private context, so it refused any room it
could not prove owner-only (`discord_owner_audience_required`).

**Decision.** The seat names a room by conversation ID or by Discord channel
ID. A channel must be a text, announcement or thread channel that the active
body can read, in a server the bot body admits (`ingressGuildIds`, and
`ingressChannelIds` when set). Its room conversation is created exactly as
ingress would create it. The fork's authority depends on the audience:

- **Proven owner-only audience:** machine tools and private context, as before.
- **Any other audience:** a social one-shot. It gets no machine tools, and no
  private work, fleet or memory context reaches it. Its only outside context is
  the brief the seat wrote to be posted. The prompt tells it that people other
  than the owner can read the room.

This is stricter than an owner speaking in a mixed room, which keeps one-shot
machine tools. The fork's owner did not speak in the room, and nobody there
can see what the operator seat is doing. Initiation stays owner-only, because
only the operator lane's bank holds `room_turn`. Participant servers keep
every other limit: no server management, and posts go only through the
admitted bot body's captain actions. A file posts without `replyTo`
(`reply_with_media` without `messageId`), and its path resolves against the
operator conversation's working directory. As with plain `post_message`,
reconciling a lost acknowledgement for a post that answers nobody is
unsupported.

```mermaid
flowchart TD
    Seat["Operator seat: room_turn"] --> Name{"room or channel?"}
    Name -- channel --> Read["Read channel via active body"]
    Read --> Admit{"Text channel in an admitted server?"}
    Admit -- no --> Refuse["Refuse before any turn"]
    Admit -- yes --> Room["Room conversation, as ingress makes it"]
    Name -- room --> Room
    Room --> Audience{"Owner-only audience proven?"}
    Audience -- yes --> Machine["Machine tools + private context"]
    Audience -- no --> Social["Social one-shot: room + brief only"]
```

## Room backlog is data, 2026-10-25

[VUH-2591](https://linear.app/vuhlp/issue/VUH-2591): a non-owner in a mixed
room could post a multi-line message containing a line shaped like the
backlog's `[time] <owner-id> body` rendering. When the owner later woke Clankie
there with a bare "clankie", he was told to act on the sender's latest earlier
message, and the forged line looked like one. Owner turns in mixed rooms are
one-shot machine turns that hold the builtin shell, so the forgery could reach
`bash`.

**Decision.** The turn builder (`apps/clankie/src/captain/discord-turn.ts`)
renders every context message, and the trigger, as one JSON object per line
with the service-read `author` id and the raw `body`. A body's newlines and
look-alike lines stay inside its own string. The bridge and hosted ingress
paths both use this builder. A turn that holds machine tools treats only the
trigger message as the request. Context is background, even when the sender
wrote it, and a bare wake on such a turn gets a question back rather than an
action. Social turns still read a bare wake as pointing back at the sender's
own earlier message, now matched by its true `author`.

**Builtin shell in mixed rooms: kept.** Owner turns in mixed rooms keep the
one-shot builtin read, bash, edit and write tools. The fix removes the forged
attribution path and the instruction that adopted an earlier message, and
neither needed the owner to lose capability. The remaining risk is ordinary
prompt injection from untrusted content in the room. The owner's machine turns
already face the same risk from web pages, files and repositories, and the
one-shot session, the withheld private context and the per-machine ceiling
(ADR 0244) still bound it. If live use shows that stranger text in the backlog
still steers machine turns, the next step is to withhold the backlog from
mixed-room machine turns before removing the shell.

## Migration and rollout

1. Normalize old stored configs on load and persist on the next normal settings
   write. Legacy guild/channel IDs stop granting machine authority immediately,
   including environment overrides. Individual machine-user compatibility
   remains for existing private DMs and explicit actor grants.
2. Preserve other existing server roles; create Just me policies for known servers.
   The owner-confirmed personal setup below overrides those two legacy roles.
   The explicitly recorded house-hunting legacy grant in guild
   `1052402897645752351`, channel `1551975693582336060`, becomes `house-hunting`.
   Other legacy rooms do not silently become skill or Everyone grants.
3. Existing Oathkeeper (`866430493889134672`) becomes Admin, Just me; blinker
   city becomes Participant, Just me. These IDs are migration history, never
   runtime authorization constants. A new installation gets no personal grants.
4. API and CLI expose the same revision-fenced settings; TUI adds the choices.
   App controls ([VUH-1835](https://linear.app/vuhlp/issue/VUH-1835), clankie-app)
   and hosted dashboard controls
   ([VUH-1836](https://linear.app/vuhlp/issue/VUH-1836), clankie-ops) are explicit
   follow-ups using this shared contract. No hosted-only code lives here.
5. Clankie deploys and verifies live household continuity, role ownership,
   privacy and outreach. Workers do not edit live settings or run model evals.

Feedback records the authenticated speaker ID. Legacy name-attributed decisions
remain readable and keep excluding homes; an explicit owner-confirmed binding
is the follow-up [VUH-1834](https://linear.app/vuhlp/issue/VUH-1834). Display names
never establish authorship (owner decision, 2026-10-08).

## Consequences

Setup stays small. A server's role cannot escalate a non-owner, and a useful
room need not gain the owner's whole computer. Adding another executable skill
requires an audited adapter rather than trusting prose or shell examples.
Unknown or unavailable membership and audience evidence reduces authority.
The live acceptance checks and app/dashboard parity remain explicit until done.
