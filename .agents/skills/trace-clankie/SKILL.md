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
`meta.json` under `inboundAcceptances`, independently of event trimming and pane
lifetime. Join their `runId` to the accepted/completed/failed `events.jsonl` turns.
`stored` proves retention; a transport completion still does not prove reading.
A service-interrupted attempt stays uncertain. Read first and acknowledge only
fully reviewed offered IDs with `clankie agents reports ack ID... --conversation ID`.

For a stuck `message_clankie` claim, compare the exact authenticated receipt with
the worker's running bridge version. Worker bridge 0.6.2 recognizes only `stored`;
it keeps returning `uncertain` even when the service returns an exact sealed
`definitive: not_sent`. Updated files on disk do not update an already imported
bridge. Keep the original claim and truthful receipt; never label an unsent
message `stored`, delete runtime state, or send a replacement to bypass this gap.

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
- Opt-in service CPU profiles: set `CLANKIE_CPU_PROFILE_DIR` in the actual launcher's environment for the next planned start/restart; Node writes `.cpuprofile` on graceful service exit. Only Clankie is profiled, not preparation or helpers. Relative directories resolve against the runtime root. Existing live processes are unchanged; a prefixed `clankie update` does not forward this variable into its live-service-owned update helper. Arrange it for the next planned deployment with the operator; do not introduce an extra restart. See `docs/cli.md` under service lifecycle.
- What's on the TUI screen right now: `herdr pane read <pane> --source visible`

Shapes, retention and the Discord media and Linear activity details are in
[the trail map](reference/trail-map.md).

For fleet proof alerts, start with `clankie metrics --fleet` and its coverage
start; compare rates only within a settled runtime. In the private service log,
join `fleet.local_proof.refusal_context` and project-stage diagnostics by
`requestId`. The fixed route and `operation` distinguish fleet admission from
project membership. `claimedPane` and `claimedBridgeId` are caller claims;
`callerPid` plus `callerBirth` comes from a kernel observation. Check
`callerAttribution` and `callerObservedAt`: a previous observation is historical,
and `unknown` does not identify a sender. A project pane-not-found is distinct
from harness, launcher, foreground, process/session/binding and transport failures.
Do not infer the historic sender from today's connected processes. Retain actual
PID/pane/socket details privately and publish sanitized counts and stages. See
`docs/cli.md` under `metrics --fleet` for the bounded diagnostic sampling.

## Read next, only for the question at hand

- [Captain turns and Discord text](reference/captain-and-discord.md): replies
  that never arrived, absorbed or declined turns, presence, the TUI viewport
  and the roster.
- [Voice](reference/voice.md): hearing versus answering, cutoffs, mute mouths,
  Vox readiness, watch and publish, leaves.
- [Play](reference/play.md): journals, screenshots, journeys, hosted worlds.
- [Queries](reference/queries.md): copy-ready `jq` reads for the trails above.

For a Discord room, start with `clankie discord rooms` and its `/conversation` heard/said/tool history. Counters are bounded observed deliveries, not proof of complete gateway coverage. Pending/absorbed is not confirmed answered. `clankie discord call` shows current voice activity and handoffs; exact words require opt-in transcript logging. See `docs/discord-rooms.md`. Private owner guidance queues through its dedicated API/CLI and never posts as the owner or grants room tools.

When the trail ends in a defect in Clankie's own code, the fix, runtime update
and restart loop is in `this-machine` under "Fixing yourself".
