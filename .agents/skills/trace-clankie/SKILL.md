---
name: trace-clankie
description: Use when tracing what Clankie said, did, or observed after the fact — operator console chat, Discord presence, play sessions, or service state — and you need to know which durable trail holds it and how to read it safely.
---

# Trace Clankie

Every surface leaves a durable trail. Find the right one, read it (everything
is append-only JSONL or plain files now), never write to it.

## The trail map

| What you want                            | Where it lives                                                                 | Shape                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator console chat (the TUI dialogue) | `~/.clankie/captain/conversations/<conversationId>/`                           | `meta.json` (title, revision, session state) + append-only `events.jsonl` (`message` role/text, `reasoning`, `tool`, `turn` phases). Cursors are zero-padded line counts. |
| The pi session behind a conversation     | `~/.clankie/captain/conversations/<conversationId>/pi/`                        | pi JSONL session trees; durable voice sessions live under `~/.clankie/captain/voice/<sessionKey>/` the same way.                                                          |
| What he heard/said per room              | `~/.clankie/captain/lanes/<lane>~<encoded-target>.jsonl`                       | One JSONL file per lane+target; `observe_room` and the TUI lanes view read the same files.                                                                                |
| Presence + system events                 | `~/.clankie/events.jsonl` (override: `CLANKIE_EVENT_LOG`)                      | One `DomainEvent` per line, full JSON. Heartbeats are not persisted; everything else is. Replayed at boot to rebuild presence.                                            |
| Play sessions (GBA)                      | `~/.local/state/clankie/gba-play/*.jsonl`                                      | Header / per-turn (monologue, intent, `detail` with position + transcript) / summary.                                                                                     |
| Who held the GBA body                    | `~/.local/state/clankie/gba-body/possession-events.jsonl` (beside `body.lock`) | Lease transitions: acquired, released, expired, stolen, refused.                                                                                                          |
| Discord semantic actions                 | `~/.local/state/clankie/discord-live-receipts.jsonl`                           | What the bridge actually did — content-free receipts, never message bodies.                                                                                               |
| Service stdout + lifecycle               | `~/.local/state/clankie/<id>.log`, `<id>-service.json`                         | Service ids: `clankie`, `discord-bridge`, `activity`, `tunnel`.                                                                                                           |
| Live status                              | `clankie status` / `clankie trace [--lane]` / `/trace` in the face             | Live only — nothing historical. `clankie trace` currently has no live transport and says so; `/trace` watches lane state via the service.                                 |
| What's on the TUI screen right now       | `herdr pane read <pane> --source recent`                                       | Viewport only — see caveat below.                                                                                                                                         |

## Gotchas that cost real time

- **The TUI is fullscreen** — `herdr pane read` returns only the currently
  rendered screen. The chat transcript is _not_ in terminal scrollback; read
  the conversation's `events.jsonl` instead.
- **Presence phases are edge-triggered at the event level.** `discord.presence.*`
  and `captain.presence.*` phases persist until the owning process emits the
  next transition, so judge liveness by the **age of the last event** for that
  session id, never by the stored phase alone. The console keys presence rows
  by bot binding (a successor's first event retires its predecessor's row) and
  stamps each row `· since <t>` — a live phase with an old stamp is a dead
  process that never got a successor.
- **The agent roster only sees Herdr panes.** Clankie leads coding agents
  through the herdr CLI; there is no worker protocol reporting to the service.
  Inside Herdr the console lists panes from `herdr pane list` as
  `[<agent> · herdr]` rows; outside Herdr an empty roster only means "no
  visibility" — check `herdr pane list` yourself.

## Queries that answered real questions

Last N chat messages in a conversation:

```bash
tail -n 40 ~/.clankie/captain/conversations/<id>/events.jsonl | jq -c '{type, role, text}'
```

What happened tonight, minus presence noise:

```bash
jq -c 'select(.type | startswith("captain.presence") | not) | {type, occurredAt}' ~/.clankie/events.jsonl | tail -n 60
```

Is a presence session real or a ghost:

```bash
grep '<session-id-prefix>' ~/.clankie/events.jsonl | tail -n 5 | jq -c '{occurredAt, phase: .data.phase, reason: .data.reason}'
```
