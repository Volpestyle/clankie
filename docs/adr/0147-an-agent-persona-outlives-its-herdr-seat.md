# ADR 0147: An agent persona outlives its Herdr seat

Status: accepted (James, 2026-08-30). Refines
[ADR 0135](0135-a-herdr-seat-is-a-conversation.md) and
[ADR 0146](0146-a-channel-is-a-conversation-several-seats-share.md).

## Context

Four identities meet in the fleet lane:

- a **subject** is the immutable managed-agent name that presents a character,
  or a stable pane-derived key for an unnamed agent in the selected session;
- a **persona** is the durable agent character the operator knows;
- a harness **occupant** is one resumable Claude, Codex, Pi, or other native
  session; and
- a Herdr **seat** is the terminal address that occupant currently uses.

Treating the seat as the character makes a pane move look like a new coworker,
makes closing a pane delete the apparent contact, and leaves Discord messages
named after terminal ids. Treating every Discord guild alike also lets a room
projection put the fleet into a server Clankie merely visits.

## Decision

The persona owns the agent's name, appearance, direct conversation, and channel
membership. A seat owns only live status, working directory, terminal access,
and routing to the current pane. Closing a seat removes the live binding and
keeps the persona and its conversations.

The host keeps three independent identity columns:

- the immutable **subject** is Herdr's managed-agent name, assigned when the
  operator hires the character; an unnamed agent uses a one-way hash of its
  pane id, which is stable for that seat and never confused with its occupant;
- the **persona id** is a random opaque id minted once and persisted against
  that subject; and
- the **occupant id** is a hash of Herdr's harness-native
  `agent_session { source, kind, value }` tuple.

A replacement harness session presenting the same managed subject therefore
occupies the existing persona. Moving either occupant or persona to another
terminal changes only the live binding. Changing a persona's display name does
not rename its immutable subject. The owner-selected Herdr session is the fleet
boundary (ADR 0149), so an unnamed agent inside it is also a character; its
pane-derived subject keeps the persona stable across service restarts while that
pane exists, but cannot claim to be the same character in a different pane.
Legacy seat-scoped conversations and channel members migrate in place when the
host first discovers their persona; the transcript is never copied or split.

Naming is not only a hiring act. `herdr agent rename` gives a name to an agent
the operator is already talking to, so the rename re-keys that character from
its pane-derived subject to the name and adopts the name as the persona's
display name. Only the rename itself adopts it; a later name chosen in the app
survives every census after. Herdr names are free-form and a subject is a
persisted key, so the host slugs the name deterministically — the same name
always recovers the same character — and a name with nothing to slug leaves the
seat on its pane-derived subject rather than writing a record the store cannot
read back.

```mermaid
flowchart LR
  Subject["Subject<br/>Herdr name or pane-derived key"] -->|persisted binding| Persona
  Persona["Agent persona<br/>name · appearance · DM · memberships"]
  Session["Harness occupant<br/>session hash"] -->|currently presents| Persona
  Seat["Herdr seat<br/>terminal id · status · cwd"]
  Session -->|currently occupies| Seat
  Seat --> Pane["Current pane"]
  Persona --> Log["Canonical host conversations"]
  Log --> App["Clankie app Messaging UI"]
  Log --> Discord["Controlled swarm-home Discord"]
```

`personas.json` is the host-owned identity record. The app edits that record
through `update_persona`; it does not keep a second persona store. The app and
Discord both render names and appearances from the same record, and both read
the same host conversation logs. Its persisted subject binding updates the
occupant column when a replacement session appears; persona ids are never
derived from credentials, sessions, panes, or display names. Version-1
session-derived records are retained only by the one-time state migration so
their existing conversations and avatar files remain addressable.
Public persona reads carry a separate 1,000-record bound; they do not inherit
the 48-entry live-seat roster bound because closed seats leave durable personas.

Appearance identity is the full `variant × accessory × shape` tuple. Gold is
reserved for the operator, leaving six agent variants; accessories and shapes
expand the default space and remain durable when the persona moves. The app
bakes the exact deterministic face it renders into a PNG. The host validates
the PNG, hashes its bytes, and publishes a content-hashed HTTPS URL through the
existing Activity server and `activityTunnelHostname`. Discord fetches that
URL server-side, so data URIs and local paths never enter the contract.

Discord projection remains available only in `swarmGuildId`, the server
Clankie controls. Ingress, presence, voice, and ordinary conversation in other
allowlisted guilds describe Clankie inhabiting them and confer no connection to
his fleet.

## Alternatives considered

- **Use terminal id as character id.** Rejected: a terminal is an address, and
  moving or closing it must not replace or delete the person using it.
- **Derive persona id from the harness session.** Rejected: a restart rotates
  the occupant and would orphan the character precisely when persistence is
  needed.
- **Keep personas in the app.** Rejected: Discord and every other surface would
  gain a competing source of truth.
- **Give every agent a bot or user account.** Rejected: one webhook already
  supports per-message names and avatars without per-agent credentials.
- **Serve a data URI or local asset path.** Rejected: Discord fetches webhook
  avatars from publicly reachable HTTPS URLs.

## Consequences

- Offline agents remain in Messages with their history; only their terminal
  action and live body disappear.
- A persona can move between panes without changing its DM or channel identity.
- A managed agent restart changes its occupant id and retains its persona id.
- Every agent in the owner-selected Herdr session appears in the fleet. Naming
  one gives it a rebinding key that follows it to another pane; an unnamed
  agent's persona stays tied to its current pane.
- Renaming a seated agent in Herdr is visible in Messages as that contact taking
  the new name, with its conversation intact — not as the contact going offline
  beside a new one named after a terminal title.
- The app is responsible for rendering proprietary skin art; the public host
  stores only semantic appearance fields and baked PNG bytes.
- Content-hashed filenames make Discord avatar changes immediate despite its
  server-side cache.

## Human hire names and owner rename (VUH-1537)

The model-facing hire tool asks for a short human name and requires an assignment
role; older spawn API callers retain their optional role contract. Known routing
labels from older callers receive a deterministic fallback from a small set of
human names across languages before native launch and persona adoption. This is
compatibility display content, never an authority or allocation key. The model
chooses ordinary hire names freely, with no Western-only validation or pool.

A previously saved persona name wins on re-adoption and resume. The roster title
projects that saved name, while native routing/session IDs remain intact. Census
refresh and service restart preserve the owner's rename. The existing
update_persona operation accepts omitted appearance for an atomic name-only
change; older rename/restyle clients continue to work. CLI and TUI expose
agents rename through that operation, without a duplicate endpoint.

## Amendment: one persona per hire when Herdr drops its name, 2026-10-28

Tracks LOCAL-VUH-59 (Clankie Work). Clankie starts every hire under a tagged
Herdr handle, such as `wynn-e3f1`, and adopts it under the name the lead gave
it. Herdr drops that handle from a Claude pane: its saved session keeps the
pane label but no `agent_name`, and only Codex panes keep theirs. About 30
seconds after each hire, the census then saw an unnamed pane and minted a
second persona for the same native occupant, under the pane's key. It was named
after the terminal title or given a picked name such as "Quill". The roster
showed that stranger, and anything that needs the occupant's single persona,
like tracker attribution, found two and named the seat instead. The census had
also filed Clankie's own handle as if the owner had typed it, so the hire's
persona was named `wynn-e3f1` rather than Wynn.

Now the census works from two recorded facts, never from a name's shape. Owner
names and hire handles look alike: Herdr names are lower-case slugs, and an
issue-numbered name such as `vuh-2933` ends in four hex digits just like
Clankie's tag.

- **Clankie's handle.** A binding records `hired` when Clankie minted its
  subject: at adoption, or on the next census when Clankie's hire ledger
  (ProjectHires) holds a started hire for that occupant, or for that pane
  while its session is not yet known, and the subject is the census's key for
  `herdrAgentName(title, tag)`. A persona the census files under such a
  handle reads like a hire's name ("Wynn"), and the hire's own title replaces
  it at adoption, as it already replaces a title the harness wrote.
- **The owner's name.** `ownerNamed` records each persona the owner named,
  through `update_persona` or a Herdr rename the census adopted. Any other
  Herdr name, whatever it looks like, is the owner's.
- When a pane reads as unnamed and its exact occupant holds exactly one
  `hired` binding, the census keeps that binding as the seat's persona. The
  pane's own binding for that occupant is dropped, so one occupant has one
  persona. The pane's persona stays as an offline record with its history.
- A persona marked as the owner's is never moved or renamed. If it is the
  pane's persona, the seat keeps it and both bindings stay. A pane with no
  hire behind it keeps its pane persona, marked or not.

Both markers live in `personas.markers.json`, beside `personas.json` and never
in it. The previous runtime reads `personas.json` strictly, so the owner can
still roll back. A missing markers file reads as empty, and the next census
marks hires again from the ledger. A name the owner gives while rolled back is
not marked. A body transfer (ADR 0286) moves the markers file with
`personas.json` and replaces the destination's own.

Existing seats switch from their pane personas (Quill, Fern and the like) to
their hire names (Sable, Odette) on the next census after deploy. Their
bindings are recognised from the hire ledger. A persona already named after
its own handle is renamed the same way when its seat is next observed.

No durable trail shows which existing names the owner gave in the app.
`update_persona` was not logged, and the conversation title it rewrites is
also written by the census, with no history. So an unmarked pane persona on a
hired occupant counts as the census's. If the owner renamed one before this
change, the seat now shows the hire's name; the renamed record is kept
offline. An occupant with no allocation, such as a hire from before the ledger
began on 2026-10-03, keeps both bindings.
