---
name: trace-clankie
description: Use when tracing what Clankie said, did, or observed after the fact — operator console chat, Discord presence, play sessions, or service state — and you need to know which durable trail holds it and how to read it safely.
---

# Trace Clankie

Start from the owning conversation and its source references. Read durable
journals and receipts; never alter runtime state files to repair a missing trail.
A snapshot or presence card describes an observation, not completion evidence.

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

A live attached native seat receives that conversation's worker reports, wakes
and watches. Worker reports follow the hiring/adopting conversation, not always
`global-default`. Peer exchanges are agent-role audit context and do not wake him.
Use `this-machine` for current routing and the retained delivery receipt for its
stage; transcript presence alone does not prove an effect or model awareness.

## Where to look

- Operator console chat (the TUI dialogue): `~/.clankie/captain/conversations/<conversationId>/`
- Native seat turns: the harness transcript, projected into `~/.clankie/captain/conversations/<conversationId>/events.jsonl`; use `clankie agents read HOST:SESSION --tail 20` for bounded native history.
- Per-turn tool-shape metrics: `~/.clankie/captain/turn-settled.jsonl`, read with `clankie metrics` or `GET /v1/captain/turn-metrics`
- The pi session behind a conversation: `~/.clankie/captain/conversations/<conversationId>/pi/`
- What he heard/said per room: `~/.clankie/captain/lanes/<lane>~<encoded-target>.jsonl`
- Tool calls he made in a room: `~/.clankie/captain/rooms/<sessionKey>/`, `~/.clankie/captain/voice/<sessionKey>/`, `~/.clankie/captain/turns/<lane>~<encoded-target>/*.jsonl`
- Presence + system events: `~/.clankie/events.jsonl` (override: `CLANKIE_EVENT_LOG`)
- Goal decision journal: `~/.clankie/captain/goal-journal/<encoded-conversation>.jsonl`
- Durable memory: `~/.clankie/memory/discord-people/*.json`, `captain-episodes/*.jsonl`
- Play sessions (GBA): `~/.local/state/clankie/gba-play/*.jsonl`, `.screenshots/<journal-stem>/*.png`
- Historical shared-body artifacts: `~/.local/state/clankie/gba-body/possession-events.jsonl` and `body.lock`, when left by an older build
- Official-bot Discord actions: `~/.local/state/clankie/discord-live-receipts.jsonl` (override: `DISCORD_BRIDGE_RECEIPT_PATH`)
- User-session Discord actions: `~/.local/state/clankie/discord-user-session-receipts.jsonl` (override: `DISCORD_USER_SESSION_RECEIPT_PATH`)
- Opt-in development voice transcript: `~/.local/state/clankie/discord-voice-transcripts.jsonl`
- Browser recordings (opt-in): `~/.clankie/runner/browser/recordings/*.webm`, named by start time
- Service stdout + lifecycle: `~/.local/state/clankie/<id>.log`, `<id>-service.json`
- Live status: `clankie status` / `/trace` in the face
- What's on the TUI screen right now: `herdr pane read <pane> --source visible`

Shapes, retention and the Discord media and Linear activity details are in
[the trail map](reference/trail-map.md).

## Read next, only for the question at hand

- [Captain turns and Discord text](reference/captain-and-discord.md): replies
  that never arrived, absorbed or declined turns, presence, the TUI viewport
  and the roster.
- [Voice](reference/voice.md): hearing versus answering, cutoffs, mute mouths,
  Vox readiness, watch and publish, leaves.
- [Play](reference/play.md): journals, screenshots, journeys, hosted worlds.
- [Queries](reference/queries.md): copy-ready `jq` reads for the trails above.

For a Discord room, start with `clankie discord rooms` and its `/conversation` heard/said/tool history. Counters are bounded observed deliveries, not proof of complete gateway coverage. Pending/absorbed is not confirmed answered. `clankie discord call` shows current voice activity and handoffs; exact words require opt-in transcript logging. See `docs/discord-rooms.md`. Private owner guidance queues through its dedicated API/CLI and never posts as James or grants room tools.
