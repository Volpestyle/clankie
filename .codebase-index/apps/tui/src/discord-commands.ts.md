# apps/tui/src/discord-commands.ts

`/discord` — one guided wizard for Discord setup,
writing to two stores: tokens (bot, lab-only user
session, OpenAI voice key, ElevenLabs key) go to the
credential broker; public identifiers (application
id, command guild, ambient roles/users, ingress and
voice allowlists, DM policy, activity app id) go to
`settings.json`. No secret ever touches settings; the
settings write path rejects token-shaped values.

Wizard sections: Tokens (shows the redacted existing
credential before offering keep/replace/remove),
core ids, text ingress, voice, activity plane, an
env-var export view, and status. Exported helpers
(unit-tested): `resolveGuildList` (typed wins → keep
existing → fall back to the command guild),
`resolveIdList`, `describeEmptyAllowlist` (a plane
cannot be enabled with no server allowlisted), and
`describeRedactedCredential`.

Semantics encoded here: the command-registration
guild is singular on purpose (blank = global);
enabling ingress mirrors the presence allowlist to
match; snowflakes are validated with Developer-Mode
hints; the user-session credential carries a
personal-lab-only warning.
