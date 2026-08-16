# packages/discord-presence-core/src/voice-session.ts

`DiscordVoiceSession` is the media owner for one
guild voice channel and ADR 0057's two-tier
realtime flow. It is the package's only
`@discordjs/voice`/prism-media module; a lab body
may inject a video sink for music.

**Lifecycle and consent:** `join` requires DAVE,
probes transcription before succeeding, and
opens the session-bound consent registry.
`leave` fences late callbacks, stops music,
closes every realtime port, cancels timers, and
zeroes retained transcript/audio buffers. Only
permitted user streams are subscribed and each
chunk rechecks consent.

**Attribution and floor:** every gateway user
owns a separate dormant transcriber, capped at 25
with two-minute idle-LRU eviction. Final text
inherits that immutable user id, so overlapping
audio never mixes identities. A bounded JSONL
ring feeds `VoiceFloor`; addressed wakes fetch a
fresh persona/person-memory briefing, seed the
engaged model, and explicitly create a response.
Decay keeps the connection warm for five minutes;
unprompted offers let the realtime persona choose
speech or silence.

**Tools:** privileged `ask_clankie` serializes
through the unchanged `discord_voice` captain
lane, preserving fixed failure speech and the
authenticated approval handoff. Local
`look_at_screen` injects one bounded live PNG.
YouTube search/play/queue/skip/pause/resume/stop/
now use `VoiceMusicQueue`, with speech ducking
the selected audio or video sink.

**Playback and resilience:** ordered PCM playback
zeroes buffers and supports deliberate sustained-
speech barge-in with realtime truncation. Lost
speaker transcribers reconnect with bounded
backoff while needed; a lost conversation opens
lazily on the next wake. All evidence is emitted
through a failure-isolated content-free path.

**Possessor seam:** narration is context, never a
script. Every report seeds the model, but spoken
responses are interval-limited and suppressed
while other response audio plays; delivery ids
join play-journal and voice evidence. Attributed
room lines publish to subscribers with no extra
retention.
