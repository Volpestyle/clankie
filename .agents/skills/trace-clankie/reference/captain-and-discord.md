# Captain turns and Discord text: gotchas

Traps that cost real time when reading captain turns, Discord text, presence, the TUI and the roster.

- **A truncated browser result is not necessarily a browser failure.** Compare
  the model-facing text with the Pi tool's full `details`. JSON previews keep
  up to 50 KiB or 2,000 serialized lines, with a cutoff notice; page strings
  can end mid-line. Older serializers discarded oversized string lines entirely,
  leaving only a few bytes of metadata even when the browser returned the page.

- **A captain `said` line is not proof Discord received it.** Match the source
  delivery id to `discord.text.reply` and its `responseMessageId`. The official
  bot keeps unfinished deliveries in `discord-text-inbox.sqlite` beside its
  receipt log; read `deliveries` and `channels` read-only to inspect pending
  ids and scan cursors. `channel_activity` records participation and the
  messages-since-reply counter; history catch-up uses live admission, including
  unaddressed follow-ups there. On upgrade, one prior history page can establish
  participation, but an already-advanced cursor does not rewind. A saved result
  can await posting after the model finished.

- **A reconnect is not proof of Discord-side failure.** Match `gateway_reconnecting`
  and READY/RESUMED timestamps with macOS `pmset -g log` sleep/DarkWake entries.
  A sleeping host cannot receive live messages; Vox audio tick slippage on wake
  is not proof the separate Node gateway loop stalled. `Discord gateway diagnostic`
  logs allowlisted close/heartbeat/invalid-session/replay facts, never raw debug
  or message bodies. `Discord gateway reconnecting` includes maximum Node loop
  delay since boot or the preceding reconnect. Older logs lack those diagnostics;
  do not infer a specific close code from a presence phase alone.

- **The TUI is fullscreen** — `herdr pane read` returns only the currently
  rendered screen. The chat transcript is _not_ in terminal scrollback; read
  the conversation's `events.jsonl` instead.

- **Conversation metadata is not a liveness clock.** `meta.json.updatedAt` may
  stay at turn acceptance while activity and tools keep appending. Judge a live
  turn by the newest `events.jsonl` event and its accepted/completed pair.

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
  visibility" — check `herdr pane list` yourself. The roster is not the limit of
  what can be read: `clankie agents` lists, reads and resumes any Claude/Codex/Grok/Pi session by
  its transcript, here or on a configured SSH host such as the PC, whatever
  terminal it runs in (ADR 0189). Only the 200 newest transcripts per host
  resolve by ref.

- **A missing Pi tree does not identify the execution destination or outcome.**
  Pi holds a session file back until the first assistant message; stalled cold
  preparation or a one-shot failure can leave no tree. An attached native seat
  can execute the input without any Pi tree. Match the conversation's run and
  delivery receipts to its native transcript or service log. Absence alone does
  not prove that no external effects occurred or authorize resending.

- **A provider failure can resolve with no reply.** For `captain_model_failed`
  or `captain_usage_limit_reached`, read the terminal assistant's `stopReason`
  and `errorMessage` in the matching Pi tree. Older `captain_response_missing`
  receipts can hide the same failure; do not infer an empty successful run
  from that code alone.

- **An `accepted` receipt establishes admission, not execution or liveness.**
  The input may be queued, preparing, executing or awaiting native delivery.
  With no active Pi tools, service preparation and execution fail after five
  minutes without host-observed preparation progress or Pi events. The watchdog
  is suspended while one or more Pi tools execute; tools retain their own timeout
  and cancellation behavior. A full five-minute idle window resumes after the
  last tool ends. Pre-start inactivity remains bounded, and queued runs do not
  consume that timeout while waiting.
  For `conversation_turn_stalled`, match the run ID to the service log's
  conversation and stalled phase. Healthy runs have no total duration cap.
  Discord Pi stream stalls use `captain_turn_stalled`; native acknowledgments
  and escalation replies retain their own deadlines. A stall can leave earlier
  effects unknown. Inspect the original receipt before retrying; accepted or
  uncertain native delivery is never replayed into the service runner.

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
