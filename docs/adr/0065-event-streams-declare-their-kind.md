# ADR 0065: An event stream declares its kind, and `missionId` stops meaning two things

Status: accepted (James, 2026-07-26). Implemented in `@clankie/protocol`, the
control plane, the TUI mission observer, and the garden projection.

## Context

`DomainEvent.missionId` is the append-only log's partition key. It is what
`ProjectionEventStore.readStream` reads, what the SQLite `events_by_mission`
index covers, and what optimistic concurrency counts rows against.

Subsystems that have no mission still need a partition. Rather than grow a
second key, each one minted a namespaced id and put it in the `missionId` slot:

- `captain-presence` — the captain's presence lease and turn lifecycle
- `discord-presence:<sessionId>` — one Discord bot presence session
- `embodiment:<sessionId>`, `device:<id>`, `trigger:<id>`, `pairing:<id>`,
  `character:<id>`, `discord-person:<guild>:<user>`, `captain-project:<id>`,
  `memory:retention`, `captain:episodes`

So `missionId` carried two meanings at once — "which partition" and "which
mission" — and nothing recorded which one a given event meant. Every reader that
wanted real missions had to infer it, and most did not try.

The failure was visible. The TUI's `MISSIONS` panel created a projection for
every distinct `missionId` it observed, so it listed rows like
`discord-presence:discord:bot:1530657471402737826:f35a58d0-… [present]`. Because
the bridge mints `discord:bot:<applicationId>:<randomUUID()>` at process start, a
row accumulated per bridge lifetime and never aged out — the panel caps at six,
so real missions were pushed off the list by dead presence sessions. Worse, the
observer's terminal-state set was `succeeded | failed | cancelled`, so a session
sitting in phase `off` counted as _active_ and could win default selection,
pointing the header, doctrine hash, task tree, and event tail at a bridge process
that had already exited.

Two other readers had the same root cause: the mission event feed allocated a
permanent empty `MissionBuffer` per presence session, device, and trigger; and
`projectGarden` took `events[0].missionId` as the world's mission, which a
leading presence event silently mislabeled.

## Decision

### The envelope carries a kind

`DomainEvent` gains `streamKind`, a closed enum over `EVENT_STREAM_KINDS`.
`missionId` keeps its one job — the partition key — and `streamKind` says what
that partition is. A reader asks `isMissionEventStream(event)` instead of
pattern-matching an id.

The field is **optional and never defaulted**. `seal()` re-parses the event
through `DomainEventSchema` before hashing, so a `.default()` would materialize a
field absent from historical JSON and make `verifyChain` report a mismatch on
every event already on disk. Optional-absent hashes identically to today.

### One namespace table, used by writers and readers

`RESERVED_EVENT_STREAM_NAMESPACES` in `@clankie/protocol` maps each reserved
namespace to its kind. It has two callers:

- `eventStreamKindForId(streamId)` — writers stamp the kind at append time.
  `recordEvent` in the control plane derives it from the stream id, so a new
  subsystem that mints a namespaced scope is classified without opting in.
- `classifyEventStream(event)` — readers resolve the kind. A stamped value wins;
  namespace inference is the compatibility path for the ~81 MB of events
  appended before the field existed, and for foreign writers (worker adapters,
  runner diagnostics) that copy a stream id verbatim.

Because the stamped value is authoritative for new events, the table does not
have to stay correct forever — it only has to describe what was already written.

A mission id must never begin with a reserved prefix;
`RESERVED_EVENT_STREAM_PREFIXES` exports the list.

### The TUI projects reserved streams separately

The mission observer routes by kind. Mission streams build `MissionProjection`s
as before; `discord_presence` streams build a `PresenceProjection` rendered under
its own `DISCORD PRESENCE` heading, capped at the newest eight sessions; every
other reserved kind is dropped. A dead presence session cannot appear in the
mission list, so it cannot win default selection — the bug is closed structurally
rather than by extending a list of terminal states.

The observation checkpoint goes to version 2. `parseCheckpoint` rejects other
versions and the caller replays from sequence 0, which is how a v1 checkpoint
full of phantom presence "missions" clears itself.

### No SQLite migration

`stream_kind` is deliberately _not_ a column. Nothing queries by kind at the SQL
level; the field rides inside the existing `event` JSON blob. Adding a column
would mean a backfill that re-derives kinds from id prefixes for millions of rows
to serve a query nobody makes. The migration hook in `sqlite.ts` stays free for a
change that needs it.

## Options weighed

- **A classifier function alone, no envelope field** — rejected. It works today,
  since every reserved namespace is inferable from its prefix. But it leaves
  meaning encoded in string shape forever: a new subsystem picks a prefix, forgets
  to register it, and silently becomes a phantom mission again. The point of the
  ADR is to stop deriving identity from id text.
- **Rename `missionId` to `streamId` across the envelope** — rejected as the
  wrong cost/benefit. It is the most honest model, but `missionId` is load-bearing
  in the signed mission-event cursor, `MISSION_EVENT_FEED_SCHEMA_VERSION` wire
  contract, eight HTTP routes, the worker transcript path grammar, evidence-bundle
  directory names, and the memory store's `mission_id` column. The rename buys
  clarity that `streamKind` already buys, and it invalidates every outstanding
  cursor.
- **Filter reserved prefixes in the TUI only** — rejected. It fixes the symptom
  James sees and leaves the same defect in the mission event feed, the garden
  projection, and every future reader.
- **A separate stream table keyed outside the event envelope** — rejected. The
  partition key belongs on the event; a side table would have to be kept
  consistent with an append-only log, which is the failure mode the log exists to
  prevent.

## Consequences

- **Readers get one question to ask.** `isMissionEventStream(event)` replaces ad
  hoc prefix checks. `discord-presence-session.ts` still slices its own prefix to
  recover a `sessionId`, which is a legitimate decode of its own namespace rather
  than a classification.
- **Old events keep working.** Nothing is rewritten, no hash changes, and
  `verify()` still passes on existing stores. The 81 MB control-plane log
  classifies correctly on the inference path, so the TUI is right on first launch
  rather than after the next bridge restart.
- **The feed stops leaking buffers.** Reserved streams project to nothing, so
  skipping them is observably identical apart from the leak.
- **The TUI shows less and means more.** Discord presence is still visible, in a
  section that says what it is, showing the live session rather than a graveyard.
- **A new reserved namespace is now a one-line registration** in the protocol
  table, and forgetting to register one is a visible bug (the stream reads as a
  mission) rather than a silent one.
