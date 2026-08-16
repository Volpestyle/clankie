# packages/discord-presence-core/test/realtime-session.test.ts

Both realtime tiers over fake sockets and timers.
Conversation tests pin manual-response VAD, the
`ask_clankie`/screen/music tool catalogue, bounded
PNG image items, explicit response and tool
round-trips, buffer zeroing, audio/text caps,
truncate, instruction bounds, lifetime, text-
modality output, header-only API keys, machine-
code errors, and idempotent close.

Transcription tests prove the session surfaces
bounded deltas/completions yet never sends a
response or conversation item for anything it
hears, and correctly reports lifetime and remote
closure.
