# packages/settings/src/schema.ts

The settings schema (`schemaVersion: 1`), all
strict, all non-secret:

- `DiscordSettingsSchema` — snowflake-validated
  ids and allowlists for authority (ambient/
  approval roles, owner), text ingress (guilds,
  channels, DM policy, context depth), presence,
  voice (enable, allowlists, join policy, consent
  policy `explicit`/`presence`, the possessor
  voice seam flag), and the activity plane (GBA
  application id, named Cloudflare tunnel name +
  hostname — named, not quick, so restarts keep
  the portal-configured hostname; commented with
  the 2026-08-01 dead-edge incident).
- `PersonaSettingsSchema` — displayName, aliases,
  owner-authored characterNotes, chattiness,
  replyPolicy (`addressed` default), and
  liveMessageWindow (what he _sees_, never what
  he must say). Presentation only; never
  authority (ADR 0051).
- `VoiceSettingsSchema` — ttsProvider
  (`openai`/`elevenlabs`), voice/model ids;
  elevenlabs requires a voice id via superRefine.
- `assertNoSecretShapedValue` — walks every
  string in a settings tree and throws on known
  token prefixes (sk-, ghp_, clankie_, Bearer, …)
  or Discord-bot-token shapes, so the write path
  fails closed instead of trusting the operator
  to notice.

Also exports `ClankieSettingsSchema` (with lazy
sub-defaults) and `emptySettings()`.
