# packages/settings/src/voice-resolve.ts

Voice settings ↔ `CLANKIE_VOICE_*` environment,
following discord-resolve's exact contract: env
wins on read with overrides reported
(`resolveVoiceSettings`), and the projection
(`voiceSettingsToEnvironment` /
`applyVoiceSettingsToEnvironment`) fills only
unset names. The ElevenLabs identifiers are
projected only when the provider is actually
`elevenlabs` — the env parser treats a
set-but-ignored identifier as drift and fails
loudly, so a stored-but-inactive config must
never manufacture that state.
