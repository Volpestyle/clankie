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
  can await posting after the model finished. A returned `failed` result is the
  service's settled receipt: the inbox stores it and stops (directly asked
  messages get one failure reply; the owner gets one runtime alert). Only
  transport errors stay pending. For why a room turn failed, read
  `roomHandoff.result` in `captain/conversations/handoff-*/meta.json`.

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

- **A worker message is not a completion harvest.** Native `message_clankie`
  reports carry `kind="message"` as untrusted agent output; completion harvests
  remain `kind="watch"`, and self-wakes remain `kind="wake"`. Match the original
  receipt and service-resolved lead conversation. A room-owned worker message
  still needs its correlated native reply through the original room authority;
  its tag does not turn the worker's words into owner instructions.

- **Bridge age is a reload hint, not build or delivery evidence.** Doctor and
  the roster report `freshness: older-than-runtime` when the observed bridge
  started before the running service, including a same-build service restart.
  Read transport presence separately; `current` is a start-time comparison and
  unavailable timing stays `unknown`. An operator bridge does not establish
  worker readiness. Reconcile uncertain delivery before another attempt.

- **The fleet roster and saved history answer different questions.** The roster
  observes native occupants in connected Herdr fleets; hires and messages use
  native harness channels/session APIs. Worker reports arrive with
  `message_clankie` at their hiring/adopting conversation. Herdr visibility alone
  proves neither report delivery nor completion. `clankie agents list|read`
  inspects saved native transcripts, including configured remote hosts and local
  registered OpenCode profiles. A saved transcript does not prove a live worker.

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

- **An operator-turn failure can be native delivery rather than a model call.**
  Join its exact run ID to the conversation journal and turn metrics before
  attributing it to model usage. Retained worker-report transport failures can
  interleave with separate Pi compaction stalls. `contextTokensStart` describes
  retained context, not billed usage; `usage: null` leaves consumption unknown.

- **A live MCP process does not prove a live channel receiver.** Tools and the
  outbox pump share a process but have separate lifetimes. The operator bridge
  retains content-free pump diagnostics in
  `$CLANKIE_STATE_HOME/clankie/seat-bridges/<pid>.jsonl` (normally
  `~/.local/state/clankie/seat-bridges/`). Match the PID, conversation, module-load
  `sourceHash`, exact event ID and stage to the native transcript and durable
  delivery receipt. `notification_sent` proves a completed channel write;
  it does not prove model review or authorize marking a provider notification
  read. An ACK outage retries exact receipts without stopping polling or
  re-notifying the event. A channel-write failure stops polling and retains the
  uncertainty fence, because the next poll implicitly acknowledges previous
  takes. Installing newer source on disk does not revive an already loaded
  stopped pump. Recover only the original harness session under the lead's
  operational authority; never substitute a route or replay uncertain input.
  A `pump_error` with `errorName: "ZodError"` means the bridge dropped a page
  it could not parse; the service had already taken those events, so they stay
  `uncertain` (2026-10-06: a 24k service handoff, before events were bounded to
  the channel limit). A pump logging nothing after `pump_started` is polling;
  look for the missing deliveries in the service's receipts, not the bridge.
  A poll failure carries `elapsedMs`, `causeCode` and `httpStatus`, never a
  message: `TypeError`/`ECONNREFUSED` is the service down, 503 is it shutting
  down, and `TimeoutError` near 35s means the service held the poll open. Before
  2026-10-07 that last case meant a pi run admitted while the seat was away had
  the conversation, and the poll waited for it to settle; the run reached the
  seat afterwards as a "Service handoff" event.

- **A restart does not hand a live seat's conversation to pi.** The head
  mailbox writes `<conversation>.json.presence` beside its receipt journal on
  each poll (at most every 5s). A new service treats a seat that polled within
  two minutes of its start as bound for 45 seconds; turns queue for it and
  return to pi only if it never polls. Without that file, or with an older one,
  an unpolled seat is unbound at once.

- **An unresolved head receipt fences only its own original.** The head
  mailbox journal is `~/.clankie/captain/delivery-receipts/head/<conversation>.json`
  (`.delivered` holds exact acknowledgements). An entry there without
  `completed`, `settlement` or `abandoned` is unresolved: a resend of that ID or
  exact content returns `uncertain` with the original's ID, while unrelated
  wakes, watches and reports keep delivering (VUH-1779). The seat gets one
  `seat-delivery-alert` message per unresolved receipt. `clankie seat-delivery
list` and `clankie doctor` show each with its age (legacy entries have none).
  Never edit the journal. If the native transcript proves the event arrived,
  acknowledge that exact ID; if it never arrived or cannot be known, the owner
  runs `clankie seat-delivery settle ID abandoned-unknown --conversation C`,
  which records `abandoned-unknown`, claims no receipt and resends nothing.

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

- **`absorbed` is not `declined` or answered.** It records input folded into a
  live run (ADR 0118); inspect that run's final reply and delivery. Since
  2026-10-06 a text follow-up from the same actor under the same grant steers
  that actor's running room handoff (ADR 0229 amendment): its child record is
  completed with "Answered with the running request <child>", and
  `replyDeliveryId` names the owning delivery. `declined`
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
