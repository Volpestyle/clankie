# packages/discord-presence-core/test/voice-session.test.ts

Largest package suite: `DiscordVoiceSession`
over fake realtime ports, clock/timers, music
sinks, sight, and Discord voice plumbing.

It covers DAVE lifecycle, join-time transcription
probe, consent/revocation, one transcriber per
gateway speaker, overlap-safe attribution,
listener capacity/idle eviction/reconnect,
conversion and zeroing, floor wake/hold/decay,
briefing/ring seeding, warm reuse, unprompted
speech vs silence, playback receipts, and
deliberate barge-in.

Tool tests exercise serialized `ask_clankie`,
approval/failure/silent outcomes, bounded screen
still injection, every music tool, trace evidence,
and speech ducking. Possessor tests pin delivery-
id correlation, context seeding, rate/playing
suppression, push-only attributed room lines,
burst collapse, and subscriber isolation. Leave
tests fence late callbacks and zero all retained
content.
