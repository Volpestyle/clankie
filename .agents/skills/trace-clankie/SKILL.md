---
name: trace-clankie
description: Use when tracing what Clankie said, did, or observed after the fact — operator console chat, Discord presence, play sessions, or service state — and you need to know which durable trail holds it and how to read it safely.
---

# Trace Clankie

Every surface leaves a durable trail. Find the right one, read it (everything
is append-only JSONL or plain files now), never write to it.

## The trail map

| What you want                            | Where it lives                                                                                               | Shape                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator console chat (the TUI dialogue) | `~/.clankie/captain/conversations/<conversationId>/`                                                         | `meta.json` (title, revision, session state) + append-only `events.jsonl` (`message` role/text, `reasoning`, `tool`, `turn` phases). Cursors are zero-padded line counts.                                                                                                                                     |
| The pi session behind a conversation     | `~/.clankie/captain/conversations/<conversationId>/pi/`                                                      | pi JSONL session trees; durable room sessions live the same way — voice under `~/.clankie/captain/voice/<sessionKey>/`, Discord text under `~/.clankie/captain/rooms/<sessionKey>/` (ADR 0118).                                                                                                               |
| What he heard/said per room              | `~/.clankie/captain/lanes/<lane>~<encoded-target>.jsonl`                                                     | One JSONL file per lane+target; `observe_room` and the TUI lanes view read the same files.                                                                                                                                                                                                                    |
| Tool calls he made in a room             | `~/.clankie/captain/rooms/<sessionKey>/`, `~/.clankie/captain/turns/<lane>~<encoded-target>/*.jsonl`         | Ordinary Discord text runs in the room's durable tree under `rooms/` (ADR 0118). `turns/` holds one pi tree per _one-shot_ — every privileged turn, and text turns from before 2026-08-18 — with full `toolCall`/`toolResult` args and results, under the same directory name as the lane log file. ADR 0107. |
| Presence + system events                 | `~/.clankie/events.jsonl` (override: `CLANKIE_EVENT_LOG`)                                                    | One `DomainEvent` per line, full JSON. Heartbeats are not persisted; everything else is. Replayed at boot to rebuild presence.                                                                                                                                                                                |
| Durable memory                           | `~/.clankie/memory/discord-people/*.json`, `captain-episodes/*.jsonl`                                        | Approved person facts grouped by guild/user plus one global bounded episode ring stored across source-lane files. `/memory status` reads the same store through the operator-only API.                                                                                                                        |
| Play sessions (GBA)                      | `~/.local/state/clankie/gba-play/*.jsonl`, `.screenshots/<journal-stem>/*.png`                               | V1/V2/V3 headers and V1/V2 turn lines. V3 adds the stable journey, environment, and venue that join sittings; V2 binds causal evidence. Selected turns and summaries may reference bounded PNGs by relative path, dimensions, byte size, hash, and capture reason.                                            |
| Historical shared-body artifacts         | `~/.local/state/clankie/gba-body/possession-events.jsonl` and `body.lock`, when left by an older build       | Inert historical files only. Current play and GBA MCP neither read nor write them; do not infer current ownership from them.                                                                                                                                                                                  |
| Official-bot Discord actions             | `~/.local/state/clankie/discord-live-receipts.jsonl` (override: `DISCORD_BRIDGE_RECEIPT_PATH`)               | What the bot bridge actually did, including text and bot voice — content-free receipts, never message bodies.                                                                                                                                                                                                 |
| User-session Discord actions             | `~/.local/state/clankie/discord-user-session-receipts.jsonl` (override: `DISCORD_USER_SESSION_RECEIPT_PATH`) | What the personal-lab body actually did, including voice, screen watch, and Go Live publish — content-free receipts, never message bodies or media.                                                                                                                                                           |
| Opt-in development voice transcript      | `~/.local/state/clankie/discord-voice-transcripts.jsonl`                                                     | Exists only when `discord.voiceTranscriptLoggingEnabled` is on. Exact consented final speech with body, guild/channel, stay/delivery ids, speaker id/display name, and timestamp. Mode 0600; receipts remain content-free.                                                                                    |
| Service stdout + lifecycle               | `~/.local/state/clankie/<id>.log`, `<id>-service.json`                                                       | Service ids: `clankie`, `discord-bridge`, `discord-user-session`, `activity`, `tunnel`.                                                                                                                                                                                                                       |
| Live status                              | `clankie status` / `/trace` in the face                                                                      | `/trace` lists rooms and tails their bounded `heard`/`said` lane logs through the service.                                                                                                                                                                                                                    |
| What's on the TUI screen right now       | `herdr pane read <pane> --source recent`                                                                     | Viewport only — see caveat below.                                                                                                                                                                                                                                                                             |

Discord media proof uses the log owned by the active body. Bot voice evidence is
in `discord-live-receipts.jsonl`; user-session voice, watch, and publish evidence
is in `discord-user-session-receipts.jsonl`. Fresh media-enabled readiness names
`mediaOwner: vox`; a text-only bot names `mediaOwner: none` and does not spawn
Vox. Role-scoped voice, DAVE, watch, publish, and leave receipts prove behavior
without storing message bodies or media.

## Gotchas that cost real time

- **The TUI is fullscreen** — `herdr pane read` returns only the currently
  rendered screen. The chat transcript is _not_ in terminal scrollback; read
  the conversation's `events.jsonl` instead.
- **Conversation metadata is not a liveness clock.** `meta.json.updatedAt` may
  stay at turn acceptance while activity and tools keep appending. Judge a live
  turn by the newest `events.jsonl` event and its accepted/completed pair.
- **A play journal does not prove which code revision ran.** Its header has no
  source revision, and service logs carry the package version rather than the
  commit. Compare process/restart and commit times, then use fields actually
  present in the journal to prove capabilities; a process may also have started
  from uncommitted source, so do not infer an exact commit from timing alone.
- **A screenshot reference is evidence only when its bytes match.** Resolve its
  relative `.screenshots/...` path from the journal directory and verify both
  `byteLength` and `sha256`; missing or mismatched bytes are a broken artifact,
  not permission to reconstruct a frame from a later state.
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
- **A turn with no tree never answered.** Pi holds a session file back until the
  first assistant message, so a one-shot that timed out or failed before he
  replied leaves nothing under `turns/`. Absence is evidence; pair it with the
  `discord.text.ingress` receipt that has no matching `discord.text.reply`.
- **An `accepted` receipt with no terminal one is a turn still running, not a
  lost one.** The terminal receipt lands whenever the turn settles, which for a
  wedged turn is at the 3-minute deadline — outside any window you picked from
  the accepted timestamp. Widen the window before concluding a turn vanished.
- **`absorbed` is not `declined`.** A message folded into a live run reports
  `absorbed` (ADR 0118): he answered, the answer just rode the delivery that
  owned the run. Only `declined` means he read it and chose silence.
- **A restart does not clear Discord conversation context.** The next ingress
  prompt can feed Clankie his own earlier replies from channel history, so a
  removed tool cue may still be copied after the new process starts. When exact
  wording survives a restart, inspect the turn's initial user message for that
  wording before concluding the running code is stale.
- **Typed input can belong to the active voice room.** A text-only message in
  the voice channel's attached chat does not start a `discord_presence` captain
  turn while that exact guild/channel has a live voice session. Find
  `discord.voice.text_input`, then join its `deliveryId` to
  `discord.voice.floor_decision`, `model_response`, `realtime_tool`, and
  `response`. The receipt is content-free; exact text remains in Discord, and
  the opt-in voice transcript log stays speech-only.
- **Realtime voice tool calls are receipts only.** `discord.voice.realtime_tool`
  names the tool (`ask_clankie`, `look_at_screen`, `music_*`) and its phase,
  never its arguments or result — the content fence applies. To see arguments,
  follow `ask_clankie` into the captain: the durable channel tree under
  `~/.clankie/captain/voice/`, or `turns/` when that handoff was privileged.
- **A voice capability denial may never have reached the captain.** Join the
  room delivery to `model_response`, `realtime_tool`, and `response`. A settled
  fast-path response with no `ask_clankie` receipt means the realtime mouth
  answered alone; verify the underlying host separately before blaming its
  permissions or availability.
- **Voice leaves a room transcript only when the owner enables the development
  toggle.** `get_self_state.voiceHistory` is
  closed stays only (join/leave), and it is empty while he is still in the
  channel. `get_self_state.recentVoiceSpeech` is the content-free projection:
  spoken vs suppressed, trigger, latency, tokens, stay id. `observe_room` on
  `discord_voice` is only captain `ask_clankie` handoffs (`heard`/`said` in
  `~/.clankie/captain/lanes/discord_voice~…jsonl` and the matching
  `~/.clankie/captain/voice/<sessionKey>/` tree) — not the Discord conversation.
  Receipts stay content-free. With `discord.voiceTranscriptLoggingEnabled` off,
  exact ambient speech remains memory-only; with it on, read
  `~/.local/state/clankie/discord-voice-transcripts.jsonl`. The same `deliveryId` joins the
  utterance, transcription outcome, floor decision, realtime response, and
  tool call/result; music continues under `callId` through queue, `yt-dlp`,
  FFmpeg, first-audio, and player checkpoints. These receipts contain ids,
  counts, phases, timings, and exit codes — never the transcript, search query,
  URL, model text, or PCM. Join a play turn to audio with `speechDeliveryId` on
  the GBA journal line and the same `deliveryId` on the submission / response /
  suppressed receipts. Human words persist only in the opt-in transcript log;
  otherwise they live in the bridge's in-memory window and live provider call.
  Fast-path model text and exact audible wording are not added to that log. A journal
  `speechDeliveryId` is only a join key: only a matching response, suppression,
  refusal, or settled `model_response` receipt proves the outcome. Absence of
  `discord.voice.response` does not mean the narration was lost — that receipt
  is emitted only when audio actually played, so a response that settled
  without speaking leaves `model_response` `phase: "completed"` and nothing
  else. V2 `narrationEvent` is the bounded game
  event offered to the room, not generated voice wording; exact audible wording
  remains unknown by policy.
- **Words with no audio is the mute-mouth signature.** A `model_response`
  `phase: "completed"` carrying `textCharacters > 0` whose `deliveryId` never
  reaches a `discord.voice.response` is a reply the room never heard: he wrote
  it, synthesis dropped it. `discord.voice.failed` with stage
  `speech_synthesis` names the throw. Join by `deliveryId`, never by adjacency
  — an `ask_clankie` round trip spends **one** `deliveryId` on two responses
  (the "let me check" and the answer), so a naive join credits the answer with
  the filler's audio and hides exactly the turn worth looking at.
- **An ElevenLabs byte-limit failure can follow audible speech.**
  `discord.voice.failed` with code
  `elevenlabs_context_audio_exceeded_the_byte_limit` means synthesized PCM hit
  the per-utterance safety fence, not that Discord disconnected. Earlier audio
  still plays and leaves a `discord.voice.response`; the room hears only a
  prefix. Join both records by `deliveryId` and check the code revision's cap.
  The external-voice adapter adds a conversation marker for this incomplete
  speech so the next response knows the suffix was not audible and that the
  exact cutoff is unknown.
- **Voice readiness does not prove an external mouth.**
  `pnpm discord:voice-readiness` checks the selected TTS credential but
  deliberately skips paid ElevenLabs synthesis; its engaged probe settles on
  model text. A `READY` report can therefore coexist with a broken ElevenLabs
  context lifecycle. Probe the TTS boundary directly when receipts show the
  mute-mouth signature.
- **Vox process readiness is not Discord media readiness.** `process_ready`
  must carry the exact `VOX_IPC_PROTOCOL_VERSION` before the client accepts any
  command, but it still proves only that the one child accepts IPC. Primary
  `ready`, `connection_state`, `transport_state`, `dave_state`, and transport
  error events must carry the caller's current `connectionId`. For voice,
  require `transport_state=ready` for role `voice`, positive role-scoped
  `dave_state=ready`, then a `discord.voice.joined` receipt with
  `daveProtocolVersion > 0`. Fresh app readiness must also set `mediaOwner` to
  `vox`; otherwise the evidence may predate the sole-owner migration.
- **Buffered TTS is not audible TTS.** `tts_playback_state=buffered` only means
  PCM entered Vox's queue. `started` is the first audible TTS-containing RTP
  frame successfully transmitted and starts floor occupancy. `drained` follows
  `finish_tts_playback` only after PCM, a held partial tail, and trailing output
  frames cross the sender. Join all three by `playbackId`.
- **Watch and publish are separate proofs.** A decoded watch still proves
  `stream_watch`, not `stream_publish`. A qualifying
  `discord.stream.publish_started` proves Discord accepted OP18 and OP22, the
  `stream_publish` transport and positive DAVE were ready, and Vox emitted the
  first `stream_publish_media_started` H264 event for the current
  connection/source generations. Never accept a generic ready line.
- **A local leave event is not a completed leave.** Qualifying
  `discord.voice.left` evidence records `gatewayConfirmed: true` and
  `mediaOwner: vox` only after the account gateway confirms that the body is
  detached from voice. A local session close without those fields is not the
  clean-leave proof.
- **A clean voice leave must not kill another role.** In the user body, primary
  voice, screen watch, and publish share one child but have separate leases. A
  valid leave closes `voice` while active watch/publish evidence continues;
  only body shutdown closes all roles and the child. If process inspection
  finds two Vox children or a Node voice media owner, the sole-owner proof
  fails. A text-only official-bot process is the intentional exception: it
  records `mediaOwner: none` and spawns no Vox child.
- **A missing play summary is not automatically an incomplete mystery.** Join
  the journal header `runId` to `embodiment.session.stopped` or
  `embodiment.session.failed` in `~/.clankie/events.jsonl`. A matching terminal
  event accounts for the run with its real outcome (including `lease_lapsed`)
  but never becomes a synthetic summary.
- **A hosted play has two session ids.** The play journal header's
  `environmentSessionId` is the Clankie embodiment id used for lifecycle joins.
  The PokeAgents session id (`ses_...`) lives in each V2 turn's
  `evidence.*.provenance.sessionId`; use that id to find the independent host
  journal under `~/.pokeagent-mmo/world/players/*/games/*/journal/`.
- **A journey is not a session.** New V3 journal headers carry `journeyId`;
  group those files to reconstruct Clankie's story across sittings. `runId`,
  `environmentSessionId`, hosted `ses_...`, and checkpoint ids still name one
  execution or saved state. V1/V2 journals predate this join and must not be
  assigned a journey from timing alone.
- **There is no current GBA possession trail.** Clankie's play host and every
  GBA MCP process own separate emulator/runtime instances. Trace Clankie's play
  through `gba-play/*.jsonl` plus embodiment lifecycle events; trace an MCP
  harness through its own stdio results and configured checkpoint directory.
  Old `body.lock` and `possession-events.jsonl` files are inert and intentionally
  neither migrated nor deleted.
- **`world_unreachable` is usually a missing process, not a crash.** The hosted
  world is a separate `pokeagents` server reached over a unix socket, so a
  refusal milliseconds after `embodiment.session.claimed` means nothing was
  listening. Check `ps aux | grep pokeagents` and compare its start time
  (`ps -p <pid> -o lstart=`) against the refusal — a join that lands before the
  server is up refuses, and the retry seconds later succeeds. `refused` is not
  `failed`: he never started, so there is no journal and nothing crashed.

## Queries that answered real questions

Last N chat messages in a conversation:

```bash
tail -n 40 ~/.clankie/captain/conversations/<id>/events.jsonl | jq -c '{type, role, text}'
```

Every tool he ran in a room, newest last (add `rooms/*/` for the durable text
lane, `turns/` for privileged one-shots):

```bash
jq -c 'select(.type=="message" and .message.role=="assistant")
       | {at: .timestamp, tools: [.message.content[] | select(.type=="toolCall") | .name]}
       | select(.tools | length > 0)' \
  ~/.clankie/captain/rooms/*/*.jsonl ~/.clankie/captain/turns/discord_presence~*/*.jsonl
```

Swap `.name` for the whole block to see arguments, and grep the same files for
`"role":"toolResult"` to see what came back.

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
jq -c 'select(.type == "discord.voice.response" or .type == "discord.voice.play_narration_suppressed" or .type == "discord.voice.left") | {type, at: .occurredAt, stayId: .data.stayId, deliveryId: .data.deliveryId, trigger: .data.trigger, reason: .data.reason, spoken: .data.spokenCount, suppressed: .data.narrationSuppressed, tokens: {in: .data.inputTokens, out: .data.outputTokens}}' ~/.local/state/clankie/discord-live-receipts.jsonl | tail -n 40
```

What exact consented speech did Discord transcribe in development:

```bash
tail -n 40 ~/.local/state/clankie/discord-voice-transcripts.jsonl | jq -c '{at: .occurredAt, body, guildId, channelId, stayId, deliveryId, speakerId, displayName, text}'
```

Where did one voice/music turn stop:

```bash
jq -c --arg id '<delivery-or-call-id>' 'select(.data.deliveryId == $id or .data.callId == $id) | {type, at: .occurredAt, data: .data}' ~/.local/state/clankie/discord-live-receipts.jsonl
```

Prove a personal-lab screen watch or Go Live publish from its own receipt log:

```bash
pnpm --filter @clankie/discord-user-session watch-live-proof
pnpm --filter @clankie/discord-user-session watch-live-proof -- --wait=120
pnpm --filter @clankie/discord-user-session publish-live-proof
pnpm --filter @clankie/discord-user-session publish-live-proof -- --wait=120
```

Both commands read
`$XDG_STATE_HOME/clankie/discord-user-session-receipts.jsonl`, defaulting to
`~/.local/state/clankie/discord-user-session-receipts.jsonl`. Add `--json` after
`--` for machine-readable output. Never point these proofs at the bot's
`discord-live-receipts.jsonl`.

Evaluate one production play journal with lifecycle and receipt joins:

```bash
pnpm --filter @clankie/gba-emulator gameplay:evaluate-journal -- \
  ~/.local/state/clankie/gba-play/<run>.jsonl
```
