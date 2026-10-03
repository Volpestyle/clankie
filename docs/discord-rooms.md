# Discord rooms behind the curtain

One Clankie has parallel room threads. `/conversation` reads the room's native
heard/said/tool history; it does not turn inspection into authority to send or
run tools there (ADRs [0124](adr/0124-one-self-has-many-local-threads.md),
[0176](adr/0176-every-room-is-an-inspectable-conversation.md), and
[0186](adr/0186-a-discord-room-harvests-its-own-workers.md)).

`clankie discord rooms` and TUI `/discord rooms` add delivery health. The API is
`GET /v1/discord/rooms`; its strict node-free contract lives in
`packages/protocol/src/discord-rooms.ts`. Counters describe observed outcomes in
the bounded retained delivery window (up to 4096 deliveries per room), not an
estimate of everything Discord might have sent while disconnected. A confirmed
Discord send counts as answered. Model completion does not. Buffered messages
remain pending; absorbed messages count as answered only when their linked send
is confirmed. Explicit backlog eviction counts as missed. No observations means
unknown, not zero evidence of failure. Silence reports `volitional_silence`, not
an invented explanation of the model's reasoning. Failures/escalations wake the
owner once per delivery through the existing content-free device push path.

`clankie discord guide CONVERSATION_ID TEXT` or TUI `/discord guide` queues bounded
private context for that room's next naturally admitted turn. `--clear` clears it.
Nothing is posted as James and no new turn is started. Clankie decides how to use
it and whether to answer. Guidance never upgrades the room's tools or source
grants. Writes use `POST /v1/discord/room-guidance` with an expected revision.
The local operator or an active paired device with explicit `steer` may use this
dedicated route. This does not make the device an operator. Consumption rechecks
the original author and current source; restart expires guidance whose original
authority cannot be proven. The private pending text is visible only to authorized
observers, separate from public Discord messages.

`clankie discord call` and TUI `/discord call` show the current call, speech,
listening/thinking state, consented participant count and active captain handoffs.
`clankie discord call join CONVERSATION_ID` joins an existing exact voice room only
when the configured owner is currently there. `leave`, `mute_output`, and
`unmute_output` require both conversation id and exact stay id. **Mute Clankie
speech output** interrupts and suppresses his speech, including queued speech;
it does not mute participants, change consent, pause music, or mute Go Live
publishing audio. Unmute never replays suppressed speech. These controls need
actual operator authority and preserve the original voice owner's authority and
lease incarnation. An unknown or replaced stay fails closed. Handoffs remain
model-owned actions, shown as observations rather than a new synthetic trigger.
Current speaker identities come only from consented active captures and the room
roster. Missing identity observations remain unknown; names are untrusted display
text. Mute suppresses immediately, but quiet remains unconfirmed until the exact
native playback reports stopped or drained. Lost confirmation keeps status unknown
and blocks unmute until exact native proof or the stay ends.

Exact voice words remain in the existing opt-in transcript path. Turning logging
off stops reads as well as retention. Room observation and transcripts require
operator or active paired `terminalObserve`; the existing captain transcript
consumer remains compatible. Paired requests keep their original device bearer
through the relay and recheck grants after awaited work.

`GET/POST /v1/discord/settings` reads or revision-fences the complete non-secret
Discord settings object. Writes require actual operator authority. The hosted
operator bridge still requires `mintedBy=hosted-account-operator` and
`terminalControl`; `steer` does not grant settings access. The canonical schema
lives in protocol and is reexported by settings. All 37 fields are editable under
TUI `/discord` → **All Discord settings** and existing `clankie discord set/clear`.
Credentials remain in the credential broker. Environment overrides and settings
that require a body restart retain their existing behavior; changing a stored
field does not claim the running body already applied it.

Body evidence uses an authenticated current Discord body session, exact transport
and current room allowlists. It cannot grant tools or reconstruct a source owner.
Voice health uses accepted input, explicit floor silence/failure, and actual audible
playback completion in the same live stay. Provider completion and suppressed
output never count as an answered room turn. Unattributed/ambient outputs and
unobservable outcomes remain unknown; there is no inferred voice missed counter.
Voice control nonces and lease references are host-only and never returned by
room snapshots. No endpoint acquires a second body or bypasses recovery.
