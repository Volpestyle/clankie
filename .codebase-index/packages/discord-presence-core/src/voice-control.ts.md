# packages/discord-presence-core/src/voice-control.ts

Shared loopback voice-presence control for both
Discord bodies. `parseVoicePresenceControlPath`
recognizes `/voice/join` and `/voice/leave`;
`tryHandleVoicePresenceControlRequest` validates
bounded non-empty guild/actor ids, invokes the
host executor, and writes its
`DiscordVoicePresenceResult` as JSON.

Non-matching routes return `false`; malformed
JSON or input receives the fixed
`invalid_voice_presence_request` 400 response.
