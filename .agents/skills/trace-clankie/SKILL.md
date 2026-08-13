---
name: trace-clankie
description: Use when tracing what Clankie said, did, or observed after the fact — operator console chat, Discord presence, play sessions, worker activity, or service state — and you need to know which durable trail holds it and how to read it safely.
---

# Trace Clankie

Every surface leaves a durable trail. Find the right one, read a copy, never
the live file.

## Read a copy, not the live database

The SQLite stores are live under WAL. Copy the db **and its `-wal`/`-shm`
siblings** to a scratch directory, then query the copy:

```bash
cp <store>.sqlite <store>.sqlite-wal <store>.sqlite-shm /tmp/scratch/ && sqlite3 /tmp/scratch/<store>.sqlite ...
```

Querying the live file directly can checkpoint or lock the WAL under the
running service.

## The trail map

| What you want                            | Where it lives                                                                                | Shape                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator console chat (the TUI dialogue) | `~/.local/state/clankie/captain-lanes/<sha1(root-commit)>.sqlite`                             | `operator_conversations` (id, title, session_state) + `operator_conversation_events` (`body_json` holds role, text, tool phases). Replayable per conversation by `sequence`. |
| Captain session lifecycle + token usage  | `~/.local/state/clankie/captain-sessions/<same-hash>.sqlite`                                  | Redacted **by design**: turn/session/usage/model events only. No prompts, no text. Don't look for the chat here.                                                             |
| Authoritative mission/system events      | `artifacts/control-plane/events.db` (override: `CLANKIE_EVENT_STORE`)                         | `events(sequence, event_id, mission_id, type, occurred_at, event)` — hash-chained; `event` is full JSON. Latest sequence matches the TUI footer's "live at sequence N".      |
| Play sessions (GBA)                      | `~/.local/state/clankie/gba-play/*.jsonl` + the table in `docs/08-observability-debugging.md` | Header / per-turn (monologue, intent, `detail` with position + transcript) / summary.                                                                                        |
| Discord semantic actions                 | `~/.local/state/clankie/discord-live-receipts.jsonl`                                          | What the bridge actually did.                                                                                                                                                |
| Service stdout + lifecycle               | `~/.local/state/clankie/<service>.log`, `<service>-service.json`                              | captain-eve, control-plane, discord-bridge, activity, runner, tunnel.                                                                                                        |
| Worker runs and transcripts              | `~/.clankie/runner/runner-events.db`, `~/.clankie/runner/worker-transcripts/`                 | Runner-spawned workers only (see roster caveat below).                                                                                                                       |
| Live turn stream                         | `clankie watch` / `clankie trace [--lane]` / `clankie status`                                 | Live only — nothing historical.                                                                                                                                              |
| What's on the TUI screen right now       | `herdr pane read <pane> --source recent`                                                      | Viewport only — see caveat below.                                                                                                                                            |

The hash naming `captain-lanes`/`captain-sessions` files is the repository
root commit; when in doubt take the newest file by mtime.

## Gotchas that cost real time

- **The TUI is fullscreen** — `herdr pane read` returns only the currently
  rendered screen. The chat transcript is _not_ in terminal scrollback; read
  the `operator_conversation_events` table instead.
- **Presence phases are edge-triggered at the event level.** `discord.presence.*`
  and `captain.presence.*` phases persist until the owning process emits the
  next transition, so judge liveness by the **age of the last event** for that
  session id, never by the stored phase alone. The console keys presence rows
  by bot binding (a successor's first event retires its predecessor's row) and
  stamps each row `· since <t>` — a live phase with an old stamp is a dead
  process that never got a successor.
- **Mission workers in the AGENT ROSTER come only from control-plane
  `worker.*` events.** Herdr-hosted agents (panes running claude/codex) never
  report there; when the console runs inside Herdr it lists them separately
  from `herdr pane list` as `[<agent> · herdr]` rows. Outside Herdr, an empty
  roster still only means "no visibility" — check `herdr pane list` yourself.
- **`worker.turn.settled` is an idle turn; only `worker.settled` is a
  completed worker.** (Same rule as `docs/08-observability-debugging.md`.)

## Queries that answered real questions

Last N chat messages across conversations:

```bash
sqlite3 -json <lanes-copy>.sqlite "SELECT sequence, type, occurred_at, body_json
  FROM operator_conversation_events ORDER BY sequence DESC LIMIT 40;"
```

What happened tonight, minus heartbeat noise:

```bash
sqlite3 <events-copy>.db "SELECT sequence, type, occurred_at FROM events
  WHERE sequence > <recent> AND type NOT IN
  ('captain.heartbeat','captain.presence.online','captain.presence.offline')
  ORDER BY sequence;"
```

Is a presence session real or a ghost:

```bash
sqlite3 <events-copy>.db "SELECT sequence, occurred_at,
  json_extract(event,'$.data.phase'), json_extract(event,'$.data.reason')
  FROM events WHERE event LIKE '%<session-id-prefix>%' ORDER BY sequence DESC LIMIT 5;"
```
