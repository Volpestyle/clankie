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

- **Presence phases are observations, not liveness proof.** A phase can remain
  unchanged while its owner works. Join its exact binding/session to current
  process health and newer events; an old timestamp alone does not establish a
  dead process. A successor retires its predecessor's row.

- **The fleet roster and saved history answer different questions.** The roster
  observes native occupants in connected Herdr fleets; hires and messages use
  native harness channels/session APIs. Worker reports arrive with
  `message_clankie` at their hiring/adopting conversation. Herdr visibility alone
  proves neither report delivery nor completion. `clankie agents list|read`
  inspects saved native transcripts, including configured remote hosts and local
  registered OpenCode profiles. A saved transcript does not prove a live worker.

- **A missing Pi tree does not prove no answer.** A one-shot can fail before
  the first assistant message creates its session file, while an attached native
  seat writes to its own harness transcript. Join the ingress, selected execution
  destination and delivery/reply receipts before drawing a conclusion.

- **A provider failure can resolve with no reply.** For `captain_model_failed`
  or `captain_usage_limit_reached`, read the terminal assistant's `stopReason`
  and `errorMessage` in the matching Pi tree. Older `captain_response_missing`
  receipts can hide the same failure; do not infer an empty successful run
  from that code alone.

- **An `accepted` receipt is admission.** Without a terminal receipt the run may
  still be active, interrupted or failed elsewhere. Inspect current run state,
  its configured deadline and the original receipt; a time window alone does
  not establish loss or authorize replay.

- **`absorbed` is not `declined` or answered.** It records input folded into a
  live run (ADR 0118); inspect that run's final reply and delivery. `declined`
  records the choice to stay silent. Neither status grants new authority.

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
