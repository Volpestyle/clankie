---
name: trace-clankie
description: Use when tracing what Clankie said, did, or observed after the fact — operator console chat, Discord presence, play sessions, or service state — and you need to know which durable trail holds it and how to read it safely.
---

# Trace Clankie

Start from the owning conversation and its source references. Read durable
journals and receipts; never alter runtime state files to repair a missing trail.
A snapshot or presence card describes an observation, not completion evidence.
Exact Codex message watches poll retained turn IDs/statuses, then verify against
a fresh full-history response when those change or after 30 seconds unchanged.
Native summary pages omit later queued input IDs and earlier result text, so they
cannot establish exact completion. An unresolved identity stays pending; inspect
the retained receipt rather than sending the input again.

## Start with the conversation

Use `clankie conversations list`, then `clankie conversations show <id>` (or an
unambiguous Discord channel id). Follow `nextCursor` while `hasMore`; `tail <id>`
streams live events. The TUI's `/conversation` picker exposes the same records,
with `Ctrl+O` for tool details. Discord rooms group their trusted, social, and
one-shot Pi histories in a read-only conversation; source entries name the
native journals when bounded/redacted details are insufficient. Those sessions
keep separate authority and model context. Voice rooms show captain handoffs,
not ambient speech. Historical discovery covers native room journals modified
within conversation retention (30 days); older source files remain inspectable
through the trail map.

Room handoffs also have individual child conversations shown under Clankie in
the dock and app. `roomHandoff` metadata retains the asking actor, original room,
delivery ID, executor, state and result; follow the child ID for its transcript
and the original room ID for delivery evidence. A native child reference appears
only after native ancestry is verified. Under a Codex head, every non-owner
executes as a Pi room thread with their original grant; only the verified owner
can use native Codex children. Finished jobs remain inspectable in history
without occupying the active dock above fleet seats.
An execution result is not proof that Discord delivered or spoke the answer.

A live attached native seat receives that conversation's worker reports, wakes
and watches. Worker reports follow the hiring/adopting conversation, not always
`global-default`. Peer exchanges are agent-role audit context and do not wake him.
Use `this-machine` for current routing and the retained delivery receipt for its
stage; transcript presence alone does not prove an effect or model awareness.

Read retained worker results with `clankie agents reports --conversation ID`.
The exact accepted payloads and delivery/read state live in that conversation's
`inbound-reports/` shards, committed by `meta.json`'s `inboundReportStore`
manifest. Legacy files keep them inline under `inboundAcceptances` until a save after
the runtime update reports a durable healthy cutover. Before that point the old
layout stays intact for automatic rollback. Only manifest-referenced shards are committed; unreferenced files
are not report acceptance. Report storage stays inside `inbound*` metadata fields
and `inbound-reports/`: a manifest, shard, field or file the reader cannot read
never proves nothing is unread, so startup and retention keep that conversation's
directory and log `Retaining conversation ID: why` (VUH-2831). An unreadable side
fork is skipped, not loaded; any other unreadable inbox still stops boot. Read reports older than 24 hours are compacted;
unread, delivered and uncertain reports are retained. The files are independent
of event trimming and pane lifetime. Join `runId` to the
accepted/completed/failed `events.jsonl` turns.
`stored` proves retention; a transport completion still does not prove reading.
A service-interrupted attempt stays uncertain. Read first and acknowledge only
fully reviewed offered IDs with `clankie agents reports ack ID... --conversation ID`.

For a Discord room, start with `clankie discord rooms` and its `/conversation`
heard/said/tool history. Counters are bounded observed deliveries, not proof of
complete gateway coverage. Pending/absorbed is not confirmed answered.
`clankie discord call` shows current voice activity and handoffs; exact words
require opt-in transcript logging. See `docs/discord-rooms.md`. Private owner
guidance queues through its dedicated API/CLI and never posts as the owner or
grants room tools.

## Read next, only for the question at hand

- [The trail map](reference/trail-map.md): every durable trail, its path,
  shape and retention, plus Discord media and Linear activity.
- [Captain turns and Discord text](reference/captain-and-discord.md): replies
  that never arrived, absorbed or declined turns, presence, the TUI viewport,
  the roster and model credential rejections.
- [Seat bridges](reference/seat-bridges.md): owner turns missing from a native
  seat, stuck `message_clankie` claims and no-install remote leads.
- [Fleet proof](reference/fleet-proof.md): fleet proof alerts and launcher or
  remote-pane refusals.
- [Voice](reference/voice.md): hearing versus answering, cutoffs, mute mouths,
  Vox readiness, watch and publish, leaves.
- [Play](reference/play.md): journals, screenshots, journeys, hosted worlds.
- [Queries](reference/queries.md): copy-ready `jq` reads for the trails above.

## Where to look first

- Operator console chat and native seat turns: `~/.clankie/captain/conversations/<conversationId>/`
  (`events.jsonl`; `clankie agents read HOST:SESSION --tail 20` for bounded native history)
- Per-turn tool-shape metrics: `clankie metrics` (`~/.clankie/captain/turn-settled.jsonl`)
- What he heard/said per room: `~/.clankie/captain/lanes/<lane>~<encoded-target>.jsonl`
- Presence + system events: `~/.clankie/events.jsonl`
- Service stdout + lifecycle: `~/.local/state/clankie/<id>.log` (rotated `.log.1.gz`…)
- Live status: `clankie status` / `/trace` in the face; the TUI screen itself:
  `herdr pane read <pane> --source visible`

The rest, with shapes and overrides, is in [the trail map](reference/trail-map.md).

When the trail ends in a defect in Clankie's own code, the fix, runtime update
and restart loop is in `this-machine` under "Changing yourself".
