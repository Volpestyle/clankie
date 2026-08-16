# packages/discord-presence-core/src/voice-floor.ts

`VoiceFloor` is the pure dormant↔engaged state
machine for a group voice channel (ADR 0057).
Time arrives as explicit `atMs`; it has no I/O,
timers, or `Date.now`.

`observeTranscript` yields wake, hold, release,
volition-gate-open, or ignore. Addressing always
wins and can move the floor to a new speaker;
holder speech refreshes it; other crosstalk does
not. Decay is the only release—"thanks, clankie"
is an address—and speechless VAD artifacts are
inert.

Unprompted offers open only from dormant on new
speech under the chattiness-derived hourly/min-
interval cap. `noteVolitionOutcome` accounts
taken vs suppressed and engages on a taken offer;
`taken + suppressed <= offered` is enforced by
accepting outcomes only while an offer is pending.
`tick` handles silent-room decay and
`noteAssistantSpokeAt` refreshes the 60-second
default window after playback.
