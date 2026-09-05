# Memory

Clankie keeps two durable memories under `~/.clankie/memory/`
(`CLANKIE_MEMORY_DIR` overrides the root). One is what he remembers experiencing; the
other is what he has been told about people. They have different keys, different
lifetimes, and different rules about who may read them, so they are separate
stores rather than one namespace with a policy field
([ADR 0042](adr/0042-discord-person-memory-projection.md)).

There is no database. Both stores are files the service owns, created `0700`
with `0600` contents, and the implementation is one module —
[`apps/clankie/src/memory.ts`](../apps/clankie/src/memory.ts).

![How Clankie's memory works](diagrams/clankie-memory.jpg)

[Editable Turbopuffer tldraw source](diagrams/clankie-memory.tldraw)

## Episodes — what he remembers experiencing

An episode is his own short memory of something that happened in a room or
something he wants to carry into his developing personality: an experience,
reflection, changed opinion, meaningful exchange, taste, commitment, or work in
progress. He writes them himself with the `remember_episode` tool; nothing else
authors one, and a person does not need to ask him first. It is a concise memory,
not a transcript. A summary is capped at 512 characters.

Whether a turn is worth a line is entirely his call, and the identity prompt's
`# Remembering` section is where he learns to make it
([`captain/instructions.md`](../apps/clankie/src/captain/instructions.md)) — a
tool nobody tells him he owns is a tool he never reaches for.

The realtime voice model has no direct writer. When it decides that something
in a conversation is worth keeping, it uses `ask_clankie` to ask the continuing
captain lane to write the episode. Conversation that it does not choose to save
remains ordinary bounded session context.

Episodes live in one store, sharded on disk by the lane that produced them:

```
~/.clankie/memory/captain-episodes/operator.jsonl
                                  /discord_voice.jsonl
                                  /discord_presence.jsonl
                                  /gameplay.jsonl
```

Two bounds share those files, and an episode's `retained` flag decides which one
it answers to. Unretained notes are a global ring of 128 across every lane — not
per-lane, so a busy gameplay session ages out old operator notes. Writes re-sort
every lane chronologically and keep the newest 128 unretained. A torn tail line
is skipped rather than allowed to poison the ring, so a JSONL file truncated
mid-write costs one episode instead of the file.

**Recall is automatic and hidden.** A Pi extension named `captain-memory` runs on
`before_agent_start` for every captain run and appends a card of the newest
eight visible episodes to the system prompt
([`captain/captain.ts`](../apps/clankie/src/captain/captain.ts)). He does not
call a tool to remember; the card is simply there. It is labelled as ambient
context rather than instruction or established fact, because his own past notes
are still model output. Recall failure is swallowed — a broken memory store
degrades the prompt, it does not fail the turn.

An empty ring still renders a card, saying so and naming the tool. A missing
card reads as having no memory at all, and nothing else in the prompt would
prompt the first write; the floor line retires itself once one episode exists.
A recall _failure_ stays silent instead — a broken store must not claim he
remembers nothing. The floor lives in the extension, not the store, so the
voice briefing keeps omitting an empty section rather than handing the realtime
speech model a tool it does not have.

**Visibility is decided at write time.** An episode written on the operator lane
defaults to `operator_private`; every other lane defaults to `shareable`. He can
override per call. Only the operator lane's recall sees `operator_private`
episodes; Discord and gameplay lanes see `shareable` only. The default matters
more than the filter — the gate in recall is only real if writes honor it, so
what he notes at the console stays at the console unless he says otherwise.

Episodes are not operational journals. Game joins, retries, checkpoint ids,
routine progress, and the objective of an active adventure live in the game
body's checkpoints and append-only play journals. New journal headers carry a
stable journey identity; the current or latest bounded story and the player's
last self-authored notes/objective are projected from runs in that journey
([ADR 0126](adr/0126-game-state-history-and-memory-have-separate-owners.md)). A
game moment becomes an episode only when its meaning is worth carrying outside
the adventure itself.

## Retention — what he keeps

`retain` on `remember_episode` lifts a note out of that ring. A retained episode
is never evicted by newer ones: it stays until he or the operator releases or
forgets it, across any number of busy rooms and any number of restarts. There is
still one record per memory — retaining does not copy it — so forgetting reaches
the recent and the kept view at once, and a correction is a correction
everywhere.

Retention is bounded at 1024 across every lane, and the bound is a **ceiling,
not a ring**. Reaching it refuses the next retain with a message naming the
capacity and leaves every kept record exactly as it was; the operator releases or
forgets one and retains again
([ADR 0158](adr/0158-retained-memory-refuses-rather-than-evicts.md)). When the
refusal happens on a write, the note is still written into the recent window —
the keeping is refused, not the remembering — and the tool result says
`retained: false` with the reason, so he never believes he kept something he did
not.

## Search — recall past the card

The automatic card stays the newest eight. `recall_episodes` searches the whole
store on demand: every whitespace-separated term must appear in the note or the
room it happened in, matches come back newest first, eight by default and at
most 32. It is a scan, not an index — a store this size does not need one, and an
embedding would be a dependency bought before the requirement.

Search obeys the same lane filter as the card, so an operator-private memory can
never surface in a Discord or gameplay search. Each line carries the lane, the
room, the date it happened, and its episode id — the source and date of the
recollection, and the handle a correction needs.

Both branches of `GET /v1/memory/captain-episodes` answer with a rendered card
and never with episode records. The card already carries what a lane needs;
returning records would hand a social bearer the `provenance` character and
session ids that the recent-card branch withholds — a second door to more fields
on a lane it already reaches.

## Correction — superseding a stale memory

`remember_episode` with `corrects` set to an episode id replaces that note in
place rather than appending a contradicting one, and stamps `correctedAt`. Its
room, its date, and its provenance are never rewritten: a corrected memory still
says where and when it came from, and recall shows that it was corrected. Naming
an id he cannot reach is not a silent no-op — the note is written as a new memory
and the result says it corrected nothing.

**Being able to read a note is not authority to rewrite it.** A correction needs
both: the lane must be able to see the episode _and_ own it. The operator lane
may correct anything; every other lane may correct only what it wrote itself.
`shareable` is the ordinary case, so a read-visibility check alone would let any
room rewrite a console-authored note — and model output is untrusted input, so a
room that talks him into "you misremembered that" must not reach the operator's
own record. The operator's PATCH is the other way in, and it is the only one that
crosses lanes.

## Recording never edits

`recordEpisode` only ever adds. An episode is a record of something that
happened, so a write landing on an id the store already holds is a conflict
(HTTP 409), not an upsert — a byte-identical retry returns the original, and
anything else is refused with the existing memory untouched. Without that rule a
bearer allowed to write its own room could delete a memory it could never
correct, simply by re-declaring its id.

A Discord bearer may only author the lane it serves: the text bridge writes
`discord_presence`, the voice bridge writes `discord_voice`, and anything else is 403. The request body names its own lane, so this is the write-side counterpart
to the read-side rule that a bearer — not a body — decides which lane it is.

## Person facts — what he knows about people

A person fact is a bounded note about a Discord user, keyed by
`(guildId, userId)` — one JSON file per person under `discord-people/`, with the
identity URL-encoded so a hostile id cannot climb out of the directory. Display
names are presentation only and are never the key. Raw transcripts and audio
never cross this boundary.

Each fact carries a kind, a confidence, a visibility scope, optional expiry, and
content-free provenance. The store holds 128 facts per person and evicts oldest
first.

Visibility is enforced on every ambient read:

| Scope              | Reaches a Discord turn                 |
| ------------------ | -------------------------------------- |
| `guild`            | Yes, anywhere in that guild            |
| `channel`          | Only in the channel it was recorded in |
| `operator_private` | Never — operator surfaces only         |

An expired fact is filtered at read time rather than deleted on a schedule, so
expiry is honest even if nothing has swept the file.

Two paths read them. A Discord turn gets facts visible to its own room, matched
against the turn's query. The voice briefing pulls facts for each consented
speaker before a voice session starts, and reports only counts and lengths in
its egress receipt — never content.

**A person writes them, not Clankie.** He can remember his own experience of an
interaction, but he has no tool for authoring a durable factual profile about a
person. Facts arrive through the Discord `person-memory` slash
command (`action: propose`, with the subject, body, kind, visibility, and
optional expiry), which the bridge forwards to
`POST /v1/memory/discord-people/proposals`. The same command with
`action: recall` reads back what is visible in that room.

"Proposal" is the name of the route, not a workflow: the fact applies on
arrival. The approval ceremony left with the governance machinery, and the
command's own wording about reviewed and approved facts is left over from it.

## Who reads what

The same filter applies to the automatic card and to search — recall on demand
is not a second door into another lane's memory. Writing is narrower still: a
lane authors its own room and corrects only what it wrote, and only the operator
crosses those lines.

| Lane / surface     | Episodes it sees, carded or searched | Person facts it sees                     |
| ------------------ | ------------------------------------ | ---------------------------------------- |
| `operator`         | All, including private               | All, via the operator catalog            |
| `discord_voice`    | `shareable` only                     | Guild + this channel, consented speakers |
| `discord_presence` | `shareable` only                     | Guild + this channel, on the turn        |
| `gameplay`         | `shareable` only                     | None                                     |

## Operator control

`/memory` in the TUI browses both stores and can edit, keep, release, or forget
any entry; `/memory status` prints the catalog and how much retention headroom is
left. `clankie memory` is the same reach without a TTY:

| Command                                      | What it does                                    |
| -------------------------------------------- | ----------------------------------------------- |
| `clankie memory [status]`                    | Retention headroom and the newest 20 episodes   |
| `clankie memory search <terms…>`             | The operator's view, private notes included     |
| `clankie memory retain\|release <episodeId>` | Keep an episode past the recent window, or stop |
| `clankie memory correct <id> --summary TEXT` | Supersede a stale note                          |
| `clankie memory forget <episodeId>`          | Delete the one record                           |

Episodes are addressed by id alone; the lane is resolved from the catalog,
because an id is what recall and search print. All of it needs the local operator
credential — both surfaces say so plainly rather than showing an empty memory
when it is missing.

The operator-only routes behind it are `/v1/memory` (full catalog, including a
`retention` count and capacity), `/v1/memory/discord-people/…` (recall, export,
edit, forget), and `/v1/memory/captain-episodes/…` (record, search, edit,
forget), specified in
[`apps/clankie/openapi.yaml`](../apps/clankie/openapi.yaml).

## Bounds

| Bound                     | Value | Effect                                   |
| ------------------------- | ----- | ---------------------------------------- |
| Unretained episodes       | 128   | Oldest evicted on write                  |
| Retained episodes         | 1024  | Next retain refused; nothing evicted     |
| Episodes in a recall card | 8     | Newest visible, per lane                 |
| Episodes in a search      | 8     | Newest matching, per lane; 32 on request |
| Facts per person          | 128   | Oldest evicted on write                  |
| Facts in a recall card    | 8     | Newest matching the query                |
| Episode summary           | 512   | Rejected at the schema, not truncated    |

## Migration

`retained` and `correctedAt` are optional on the schema with a default, so every
episode written before retention existed loads unchanged and unretained. Nothing
rewrites the files on upgrade; the first write after it re-derives the ring the
way any write does.

Retention is not retroactive. An episode the ring evicted before he retained it
is gone — the files are the whole store, there is no archive behind them, and
nothing can bring an evicted note back. What survives an upgrade is what was
still on disk when it happened.

## Decisions

- [ADR 0042](adr/0042-discord-person-memory-projection.md) — why person memory
  is its own projection rather than a namespace in a shared fact store.
- [ADR 0054](adr/0054-cross-lane-presence-and-episodic-self-memory.md) — why
  presence is shared across lanes while notes stay fenced.
- [ADR 0158](adr/0158-retained-memory-refuses-rather-than-evicts.md) — why a
  retained memory is refused at the ceiling instead of evicted, and why recall
  past the card is a scan rather than an index.
