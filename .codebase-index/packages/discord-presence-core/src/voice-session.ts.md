# packages/discord-presence-core/src/voice-session.ts

`DiscordVoiceSession`: the single official-bot
media owner for one guild voice channel, wired
for ADR 0057's two-tier realtime flow. The only
module in the package touching `@discordjs/voice`
and prism-media.

Lifecycle: `join` connects with DAVE encryption
required, opens the dormant transcription
listener (its failure fails the join — no silent
deafness), and opens per-session consent; `leave`
tears everything down, zeroes the transcript
ring, and bumps a session generation that every
async callback checks.

Capture: only consented user ids are ever
subscribed (`consent.permits` at speaking-start
and re-checked per decoded chunk — mission
criterion 3), Opus → 48 kHz stereo → 24 kHz mono,
streamed into the transcription session sliced to
the append cap; the engaged conversation gets a
copy only while the floor is engaged (never
during the hold window, so overheard chatter
cannot grow a priced context). Utterances shorter
than 350 ms earn no receipt.

Floor wiring: final transcripts are attributed
from gateway speaking spans (most-recent-active
heuristic — never from audio), pushed into a
bounded transcript ring (the only transcript
retention anywhere; zeroed on eviction and
leave), and fed to `VoiceFloor`. Wakes brief
(persona + person memory for whoever may be
heard), open the conversation, seed ring-then-
briefing, and announce `Speaker: <id>` items; a
release keeps the session warm for
`ENGAGED_HOLD_MS` so a wake inside the window
skips setup; `ENGAGED_TICK_MS` decay ticks catch
silent rooms. Volition offers run the injected
`volitionDecider` over ring text (absent/erroring
= suppressed, still accounted).

Ability path: `ask_clankie` is the only accepted
function call, serialized on a turn queue through
`DiscordVoiceIngress`; failures speak the fixed
`CAPTAIN_UNREACHABLE_TEXT`, approval-shaped
results keep the authenticated-surface handoff,
and a silent captain outcome says and receipts
nothing.

Playback & barge-in: streamed PCM deltas
(24k→48k stereo) play through one ordered
playback chain; buffers are zeroed when their job
ends. Deliberate truncation only — sustained
speech (≥350 ms) from the floor holder, or a
re-address from any consented speaker, stops the
player and issues `conversation.item.truncate` at
the played offset.

Possessor seam (ADR 0064): `narrate(text)` seeds
"While playing, Clankie just: …" as context
(never a script), responding at most once per
`DEFAULT_NARRATION_MIN_INTERVAL_MS` with the
decision made inside the ops queue so un-awaited
bursts collapse to one response;
`subscribeTranscript` pushes attributed ring
lines to possessors with zero added retention.

Resilience: a lost listener reconnects forever
with 1 s→30 s backoff (never silently deaf); a
lost conversation drops undeliverable pending
decisions and reopens lazily on the next wake.
All evidence goes through `emitSafely` — a
failing emitter never eats a reply.
