# packages/discord-presence-core/test/voice-floor.test.ts

Floor-machine suite under explicit `atMs` clocks.
Waking: addressed (including mis-transcribed and
closing-phrase-while-dormant), reply-policy all,
speechless transcripts inert. Holding: holder
continuation refreshes decay, re-address moves
the floor, crosstalk neither answers nor
refreshes. Explicit release: name-near-closing-
word from anyone; nameless thanks keeps the
floor. Decay: releases on silence via tick and on
late transcript arrival; a post-window address is
a fresh wake, never eaten. Volition gate: opens
under the rate cap and counts offers, respects
min-interval and the sliding hourly cap, never
opens from a timer, zero maxPerHour disables it,
defaults derive from chattiness. Outcomes: taken
engages on the provoking speaker, suppressed
counted, no-offer no-op, addressed wake racing
the outcome keeps its floor, counters monotonic
with taken+suppressed ≤ offered. Plus options
validation.
