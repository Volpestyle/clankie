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

- **A turn with no tree never answered.** Pi holds a session file back until the
  first assistant message, so a one-shot that timed out or failed before he
  replied leaves nothing under `turns/`. Absence is evidence; pair it with the
  `discord.text.ingress` receipt that has no matching `discord.text.reply`.

- **A provider failure can resolve with no reply.** For `captain_model_failed`
  or `captain_usage_limit_reached`, read the terminal assistant's `stopReason`
  and `errorMessage` in the matching Pi tree. Older `captain_response_missing`
  receipts can hide the same failure; do not infer an empty successful run
  from that code alone.

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
