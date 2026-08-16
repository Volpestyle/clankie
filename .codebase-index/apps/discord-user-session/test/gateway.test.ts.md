# apps/discord-user-session/test/gateway.test.ts

Drives DiscordUserGateway over a fake websocket:
identifies with the bare token and `capabilities`
(no bot intents), surfaces READY identity /
messages / voice server updates, resumes with the
retained session instead of re-identifying,
treats close 4004 as terminal (no retry), and
sends voice-state updates as op 4.
