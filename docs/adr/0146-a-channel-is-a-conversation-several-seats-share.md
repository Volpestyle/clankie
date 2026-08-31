# ADR 0146: A channel is a conversation several agents share

Status: accepted (James, 2026-08-30). Extends
[ADR 0135](0135-a-herdr-seat-is-a-conversation.md) and
[ADR 0147](0147-an-agent-persona-outlives-its-herdr-seat.md) — a persona keeps
one direct conversation; a channel is a conversation several personas share. Inherits the
Discord identity boundary from [ADR 0024](0024-discord-dual-plane-presence.md)
and [ADR 0048](0048-discord-user-session-transport.md). Built on 0135's native
harness transcript, which is how a member's reply reaches the round.

## Context

ADR 0135 gives every Herdr agent persona a durable DM thread. The operator can talk to any
agent, and each agent can answer — but only ever one at a time, and only ever to
the operator. `OperatorConversationScopeSchema` is a closed union of `global`,
`workspace`, `persona`, and legacy `seat`, and `create()` takes exactly one scope, so a
conversation has exactly one counterpart by construction. There is no way for
three agents working the same problem to be in a room together, and no way for
one of them to read what another already said.

The fleet works in groups. Two agents in the same working directory, a reviewer
and the implementer it is reviewing, a lead and the workers it routes to — all
of it currently happens by the operator relaying messages between DM threads by
hand.

Two capabilities the operator asked for are missing in the same place. Reactions
do not exist on operator conversations at all. Neither does any group.

Both already exist in the Discord lane, fully modelled: channels, reactions,
`typing_start`, mentions, threads. Clankie participates in Discord with exactly
the semantics wanted here. What is missing is not a design — it is the same
model on the operator's own conversations, and a way to project it back out.

## Decision

### A channel is a scope

`OperatorConversationScopeSchema` gains a `channel` kind carrying a channel id.
Membership is a property of the channel record, not of the scope, so members can
join and leave without the conversation changing identity. One shared transcript:
every member reads all of it and writes into it, and the operator is a member
like any other participant.

A persona conversation is unchanged. A channel is not a new kind of thing — it is
the same conversation record with more than one counterpart.

### Replies are emergent, not routed

There is no reply policy. Each member reads the shared transcript and decides
for itself whether to answer, add something, or stay quiet — the same judgement a
person makes in a group DM. An agent that sees its point already made says
nothing.

That behaviour is only _possible_ if replies are sequenced. Members prompted
simultaneously cannot see each other, so they would all answer at once, every
time, and the transcript would fill with three answers to every question. The
engineering problem here is turn-taking, not routing.

Members are therefore considered in order, each prompted with the transcript as
it stands at that moment — including a reply that landed a second earlier.
Passing is free and produces nothing visible: a member answers `PASS`, and a
member that is offline or silent passes for it.

The prompt a member is offered is one line, always. Herdr's `pane send-text`
writes raw bytes to the pty, so a newline inside the text lands as Enter and
submits a half-written prompt. Line breaks in the transcript are folded to a
separator on the way out.

```mermaid
sequenceDiagram
  participant O as operator
  participant C as channel
  participant A as atlas
  participant D as dev
  participant G as greenhouse
  O->>C: why is the atlas slow?
  C->>A: transcript so far
  A->>C: it re-decodes per mount
  C->>D: transcript INCLUDING atlas's reply
  D->>C: confirms what I saw in the profile
  C->>G: transcript including both
  G-->>C: (passes — nothing to add)
```

The cost is N model calls per message even when most pass, and latency of N
turns. A reply lease is the intended optimisation once channels are real:
members evaluate in parallel, claim an exclusive lease to speak, and a loser
re-reads before deciding whether to add on. The relay already owns exactly that
lease shape from `terminal_control` (ADR 0144) — request/renew/release with a
typed `contended` outcome naming the holder — so it is a known pattern rather
than a new invention, and it doubles as the channel's typing indicator.

Sequential first because it produces the behaviour; the lease is a latency fix,
not a correctness one.

### Reactions become first-class

Reactions move out of the Discord lane onto conversation entries, with ops to
add and remove and stream events to carry them. Both the operator and agents may
react. An agent reaction is the cheap acknowledgement a transcript turn is too
expensive for — _seen_, _working on it_, _agreed_ — and costs no model output.

A reaction is a side-record keyed by the entry's cursor, never a field on the
entry: entries are durable and append-only, reactions are mutable, and a
reaction arriving must not rewrite something already written. So a reaction is
its own event in the same log, an add or a removal, and the set standing on an
entry is the fold of those in cursor order. Replay, retention, and every tail
carry reactions for free, and no surface keeps a second copy that can drift.

### Discord is a second surface, not a second feature

A Clankie channel may be projected into a guild. It is the _same_ conversation:
the same transcript, the same members, the same turn-taking. Discord renders and
participates; it does not own anything. The conversation event log on the
Clankie host is the one source of truth. The app consumes that log directly;
Discord sends operator messages into it and receives agent and app-originated
messages as a projection. Both surfaces synchronize through the host; they
never reconcile two peer transcripts.

```mermaid
flowchart LR
  subgraph host[Clankie host — canonical state]
    solo[Solo Clankie conversation]
    room[Shared channel event log]
    agents[Herdr agent personas]
    agents <--> room
  end

  app[Clankie app Messaging UI] <--> room

  subgraph inhabited[Inhabited Discord server]
    ordinary[Ordinary channel]
  end
  ordinary <-->|solo ingress / presence| solo

  subgraph swarm[Explicit swarm home]
    forum[Forum container]
    post[One post / thread per Clankie room]
    forum --> post
  end
  post <-->|same conversation| room
```

- **Reads** ride the existing bot gateway — one connection, already receiving
  messages, mentions, `typing_start`, and reactions. The bridge does not hold a
  copy of which guild channels are projected: a copy goes stale the moment a
  channel is projected, so it offers each message to the service and the service
  answers whether it took it. A message nothing is projected onto comes straight
  back, so a guild Clankie merely reads is unaffected by channels existing.
- **Who may speak** from Discord is decided on the bridge, which is the boundary that
  knows who sent a message, and only the operator drives a round. A channel is a
  fan-out amplifier, so a guild member who can get an answer out of Clankie must
  not thereby get a turn out of every agent in a room; anyone else's message
  falls through to ordinary ingress, exactly as it did before the projection
  existed. Discord redelivers, so the round is keyed by message id and runs once.
- **Writes** ride a per-channel webhook, posting with a per-message `username`
  and `avatar_url` so each agent appears as itself. The operator's own messages
  are posted too when they were typed in the app — a room showing only the
  answers would be answering invisible questions — and not when they were typed
  in the guild, where they are already on screen.
- **Reactions** are performed by the bot, which already carries `react` and
  `unreact` in `DiscordCaptainActionInputSchema`.

Agent names and appearance tuples are host-owned persona state. The app bakes
the exact `variant × accessory × shape` face it renders into a PNG when a
persona is discovered or edited. Gold remains reserved for the operator. The
host validates the PNG and exposes it under a SHA-256 content-hashed filename on
the existing public Activity origin. `avatar_url` is therefore a reachable
HTTPS URL, not a data URI or local asset, and a changed hash bypasses Discord's
server-side avatar cache. Discord and the app read the same persona record and
the same conversation log; neither keeps a peer identity or transcript store.

### Identity is webhooks, and this is not negotiable

Each agent appearing as its own Discord user must not mean a real user account
per agent. ADR 0048 already treats _one_ automated user account as an accepted
ToS risk that is off by default; N of them is N violations, and the risk is the
account owner's. It must also not mean a bot application per agent — legitimate,
but a registration, a token, and an invite for every agent is exactly the
un-ergonomic setup this feature exists to avoid.

Webhooks give N apparent participants from one per-channel credential, entirely
within ToS, with nothing to register per agent.

Clankie makes the webhook himself, inside a guild the owner has already
approved — on a channel he creates for the room, or on one the server already
has. Anything less would put a trip through Discord's settings in front of every
room, and a feature whose point is that rooms are cheap to make cannot cost that
each time.

Which room a channel lands in is therefore a pick, not a paste: the swarm home's
own channel list is offered, with a new text channel as the default. A text or
announcement channel carries the room directly. A forum is a container, so
selecting one creates a new forum post whose thread carries the room. The
webhook belongs to the parent forum and every persona post names the thread id;
inbound Discord messages arrive with that same thread id and route back into the
canonical conversation. Several Clankie rooms may therefore share one forum
without sharing identity. Forums configured to require a tag stay out of the
picker because projecting without an explicit tag choice would fail or assign
meaning the operator did not choose. The list is read only when the operator opens the
choice, so a room that never goes to Discord never costs a call to it, and a
guild Clankie cannot read is an empty picker rather than an error — the
new-channel path still works.

The grant this needs already exists. ADR 0133's fence is the **guild**
allowlist: an empty channel allowlist admits any channel inside an approved
guild, which is exactly the shape "make a channel here" requires, and a
provider with no guilds still grants nothing. Bot credentials stay in the
trusted runtime module — the service asks for a provisioned room and is handed
one, rather than holding the token that could make it (ADR 0024).

### A server he controls is not a server he is in

Clankie is a member of servers he does not own, and a member of one he does.
Those are different relationships and they get different fields.

`swarmGuildId` names the **swarm home**: the one guild his agents may be given
rooms in. Every other guild he is in is one he **inhabits** — he reads it,
talks in it, joins its voice — and no path puts his fleet in it. The ingress,
presence, and voice allowlists are about inhabiting, and say nothing about
where rooms may go; `guildId` is the command and live-proof server, a third
thing again. None of them answer for the swarm home, and the swarm home is
never inferred from them: a single approved presence guild is not evidence that
the owner meant the fleet to live there. Unset means no room is provisioned.

That fence has to hold on every path into a projection, not just the
provisioning one. A pasted webhook resolves to the guild it belongs to before
anything is saved, and one outside the swarm home is refused — otherwise the
paste is a back door that puts the fleet in a server Clankie merely visits,
with no grant involved at all.

Pasting a webhook URL stays as the second path, for when Clankie lacks
`Manage Webhooks` in the swarm home and the owner makes one there by hand. It is
a fallback within that server, never a way out of it: a URL resolving to any
other guild is refused, and with no swarm home set neither path projects at all.
Because a webhook on a forum identifies only the parent and not a post, a pasted
forum webhook is refused; selecting the forum in the picker supplies the missing
post identity safely.
Either way the host keeps the token half and the operator boundary carries only
the webhook id, so the credential that can post never leaves the machine.

A channel id handed to provisioning is checked against the swarm home's own
rooms rather than trusted. The grant is guild-scoped, so an id from a guild he
only inhabits would otherwise reach a room the swarm fence was supposed to be
the whole of.

One Clankie channel per message-bearing Discord location. For a direct channel
that location is its channel id; for a forum room it is the post's thread id.
The claim is checked before Discord is touched when the location already
exists, and again against the provisioned location. Inbound guild text can
therefore resolve to exactly one canonical conversation while distinct forum
posts remain distinct rooms under the same parent.

Nothing local moves until the projection is settled. Resolving a webhook, or
provisioning one, is the part that can fail, and a room half-created by a
failure is a room the operator has to go clean up — so the guild side is
resolved first and the conversation record is written only once it holds.

The fence is checked where a projection is _used_, not only where it is written.
A record outlives the setting that admitted it: a guild dropped as the swarm
home, or a room projected before this boundary existed, would otherwise keep
routing guild text and keep posting agent replies into a server Clankie no
longer controls. So inbound routing and outbound posting both read the
projection through the same swarm check, and a room outside it is simply not
projected any more.

A projection is removed the way it is made: an upsert whose choice is `off`
drops the projection while the room and its transcript stay, and deleting or
pruning the room does the same implicitly. Either way the webhook Clankie
provisioned is deleted in Discord — retired best-effort and fire-and-forget, so
the local change never waits on Discord — while a pasted webhook is the
operator's own and stays, as does the Discord channel or forum post itself:
what was said there remains readable, it just stops being a live view. Which
webhooks Clankie made is recorded on the projection (`provisioned`); records
from before the flag are treated as pasted rather than guessed at.
Re-projecting a room elsewhere retires the old credential the same way.

The limitation is accepted deliberately: webhook posts carry a BOT tag, cannot
be DM'd, and have no presence. Inside a channel none of that is visible. Wanting
to DM an individual agent _in Discord_ would need a real bot identity, and that
is a separate decision.

## Consequences

- The fleet can talk as a group, and the operator stops hand-relaying between DM
  threads.
- Channels cost N model calls per message under sequential turn-taking. That is
  the known price of the emergent behaviour, and the reply lease is the planned
  reduction. A channel with many members is expensive by construction, which is
  a reason to keep membership deliberate.
- Discord setup is provisioning inside a guild the owner already has — channels,
  forum posts, and webhooks created by Clankie — not guild creation. It needs
  `Manage Channels`, `Manage Webhooks`, and `Send Messages` on
  the bot in the swarm home, which is named outright: an unset swarm home is
  refused rather than guessed at, because there is no right answer to which of
  the owner's servers a room belongs in, and guessing one puts the fleet in a
  server he was only visiting.
- A channel is a fan-out amplifier for anything an agent can do. Membership is
  therefore an operator decision, never an agent one.
- The app renders channels natively; nothing about the app's rendering is
  privileged over Discord's, and neither surface may hold state the conversation
  does not.
- Altering a roster fans one message out to every agent in it, so the op that
  does it is a control action and rides the `steer` grant, not `chat`. Reading
  channels and reacting stay on `chat`.
- Membership arrives as the whole list the operator wants, in turn order, and
  the host reconciles it. Joining, leaving, and reordering are therefore one
  write rather than three ops that can disagree, and a member already in the
  room keeps the `joinedAt` it had.
- A projected channel costs one extra service call per inbound guild message,
  paid on the loopback hop the bridge already makes to hand Clankie a turn. That
  is the price of the bridge holding no projection state of its own, and it is
  the reason a channel can be projected without restarting anything.
