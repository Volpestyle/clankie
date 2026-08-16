# packages/settings/src/schema.ts

Strict schema-version-1 non-secret settings.

- `DiscordSettingsSchema` — ids/allowlists for
  authority (`systemActorUserIds` is the machine-
  tool grant), text/DM/presence/voice policy,
  active bot vs user-session mouth, lab-body
  allowlists, and activity tunnel coordinates.
- `PersonaSettingsSchema` — names, owner notes,
  chattiness, agent-first `replyPolicy: all`, and
  live-message window. Presentation never grants
  authority.
- `VoiceSettingsSchema` — OpenAI/ElevenLabs
  provider/model/voice selection with required
  ElevenLabs voice refinement.
- `LinearSettingsSchema` — optional public default
  team UUID; the credential remains broker-owned.
- `EmailSettingsSchema` — bounded IMAP/SMTP host,
  port, username, and TLS coordinates; password
  remains broker-owned.

`ClankieSettingsSchema` gives each section lazy
defaults. `assertNoSecretShapedValue` recursively
rejects known token prefixes, bearer strings, and
Discord-bot-token shapes before any write;
`emptySettings()` returns the parsed defaults.
