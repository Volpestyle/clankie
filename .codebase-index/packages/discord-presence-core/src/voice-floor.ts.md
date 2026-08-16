# packages/discord-presence-core/src/voice-floor.ts

`VoiceFloor`: the pure dormant↔engaged floor
state machine for a group voice channel
(ADR 0057). No I/O, no timers, no Date.now — time
arrives as explicit `atMs`, so every decay and
rate-cap branch is provable under a test clock.

Decisions (`observeTranscript` →
`FloorDecision`): wake (addressed / reply-policy
all / volition), hold (holder continued, or a
re-address moves the floor to that speaker),
release (explicit "thanks clankie" or decay),
volition_gate_open, ignore. Precedence encodes
the failure asymmetry: being addressed always
wins (even reviving a decayed engagement as a
fresh wake); explicit release outranks the
address check while engaged; decay is evaluated
first on an engaged floor; crosstalk between
other people never refreshes decay. Transcripts
with no letters/digits (VAD artifacts) are inert.

Volition: the gate opens only from dormant, only
on new transcript (silence costs nothing), under
a rate cap (`VOLITION_DEFAULTS` per chattiness:
quiet 2/h, balanced 6/h, chatty 15/h, plus a
min interval). `noteVolitionOutcome(taken)`
records the model's verdict — a taken offer
engages the floor held by whoever provoked the
remark — and the accounting invariant
`taken + suppressed <= offered` holds because
outcomes only land while an offer is outstanding.
`tick(atMs)` is the lazy decay check for silent
rooms; `noteAssistantSpokeAt` lets his own
playback refresh decay. Default decay window
60 s (`DEFAULT_DECAY_WINDOW_MS`).
