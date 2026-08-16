---
name: trace-clankie
description: Use when tracing what Clankie said, did, or observed after the fact — operator console chat, Discord presence, play sessions, or service state — and you need to know which durable trail holds it and how to read it safely.
---

# Trace Clankie

Every surface leaves a durable trail. Find the right one, read it (everything
is append-only JSONL or plain files now), never write to it.

## The trail map

| What you want                            | Where it lives                                                                 | Shape                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator console chat (the TUI dialogue) | `~/.clankie/captain/conversations/<conversationId>/`                           | `meta.json` (title, revision, session state) + append-only `events.jsonl` (`message` role/text, `reasoning`, `tool`, `turn` phases). Cursors are zero-padded line counts.              |
| The pi session behind a conversation     | `~/.clankie/captain/conversations/<conversationId>/pi/`                        | pi JSONL session trees; durable voice sessions live under `~/.clankie/captain/voice/<sessionKey>/` the same way.                                                                       |
| What he heard/said per room              | `~/.clankie/captain/lanes/<lane>~<encoded-target>.jsonl`                       | One JSONL file per lane+target; `observe_room` and the TUI lanes view read the same files.                                                                                             |
| Presence + system events                 | `~/.clankie/events.jsonl` (override: `CLANKIE_EVENT_LOG`)                      | One `DomainEvent` per line, full JSON. Heartbeats are not persisted; everything else is. Replayed at boot to rebuild presence.                                                         |
| Durable memory                           | `~/.clankie/memory/discord-people/*.json`, `captain-episodes/*.jsonl`          | Approved person facts grouped by guild/user plus one global bounded episode ring stored across source-lane files. `/memory status` reads the same store through the operator-only API. |
| Play sessions (GBA)                      | `~/.local/state/clankie/gba-play/*.jsonl`                                      | Header / per-turn (monologue, intent, `detail` with position + transcript) / summary.                                                                                                  |
| Who held the GBA body                    | `~/.local/state/clankie/gba-body/possession-events.jsonl` (beside `body.lock`) | Lease transitions: acquired, released, expired, stolen, refused.                                                                                                                       |
| Discord semantic actions                 | `~/.local/state/clankie/discord-live-receipts.jsonl`                           | What the bridge actually did — content-free receipts, never message bodies.                                                                                                            |
| Service stdout + lifecycle               | `~/.local/state/clankie/<id>.log`, `<id>-service.json`                         | Service ids: `clankie`, `discord-bridge`, `activity`, `tunnel`.                                                                                                                        |
| Live status                              | `clankie status` / `/trace` in the face                                         | `/trace` lists rooms and tails their bounded `heard`/`said` lane logs through the service.                                                                                            |
| What's on the TUI screen right now       | `herdr pane read <pane> --source recent`                                       | Viewport only — see caveat below.                                                                                                                                                      |

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
- **Voice does not leave a room transcript.** `get_self_state.voiceHistory` is
  closed stays only (join/leave), and it is empty while he is still in the
  channel. `get_self_state.recentVoiceSpeech` is the content-free projection:
  spoken vs suppressed, trigger, latency, tokens, stay id. `observe_room` on
  `discord_voice` is only captain `ask_clankie` handoffs (`heard`/`said` in
  `~/.clankie/captain/lanes/discord_voice~…jsonl` and the matching
  `~/.clankie/captain/voice/<sessionKey>/` tree) — not the Discord conversation.
  Ambient speech is content-free by design. The same `deliveryId` joins the
  utterance, transcription outcome, floor decision, realtime response, and
  tool call/result; music continues under `callId` through queue, `yt-dlp`,
  FFmpeg, first-audio, and player checkpoints. These receipts contain ids,
  counts, phases, timings, and exit codes — never the transcript, search query,
  URL, model text, or PCM. Join a play turn to audio with `speechDeliveryId` on
  the GBA journal line and the same `deliveryId` on the submission / response /
  suppressed receipts. Human words and fast-path model text live only in the
  bridge's in-memory window and the live OpenAI call.

## Queries that answered real questions

Last N chat messages in a conversation:

```bash
tail -n 40 ~/.clankie/captain/conversations/<id>/events.jsonl | jq -c '{type, role, text}'
```

What happened tonight, minus presence noise:

```bash
jq -c 'select(.type | startswith("captain.presence") | not) | {type, occurredAt}' ~/.clankie/events.jsonl | tail -n 60
```

Does durable memory contain anything, without printing its contents:

```bash
find ~/.clankie/memory -type f -maxdepth 2 -exec wc -l {} +
```

Is a presence session real or a ghost:

```bash
grep '<session-id-prefix>' ~/.clankie/events.jsonl | tail -n 5 | jq -c '{occurredAt, phase: .data.phase, reason: .data.reason}'
```

Did he speak this stay, and are play reports dropped:

```bash
jq -c 'select(.type == "discord.voice.response" or .type == "discord.voice.possessor_narration_suppressed" or .type == "discord.voice.left") | {type, at: .occurredAt, stayId: .data.stayId, deliveryId: .data.deliveryId, trigger: .data.trigger, reason: .data.reason, spoken: .data.spokenCount, suppressed: .data.narrationSuppressed, tokens: {in: .data.inputTokens, out: .data.outputTokens}}' ~/.local/state/clankie/discord-live-receipts.jsonl | tail -n 40
```

Where did one voice/music turn stop:

```bash
jq -c --arg id '<delivery-or-call-id>' 'select(.data.deliveryId == $id or .data.callId == $id) | {type, at: .occurredAt, data: .data}' ~/.local/state/clankie/discord-live-receipts.jsonl
```
