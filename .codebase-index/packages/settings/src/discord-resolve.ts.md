# packages/settings/src/discord-resolve.ts

Discord settings ↔ environment boundary.

- `resolveDiscordSettings` merges stored values
  with `DISCORD_*`/`CLANKIE_*` variables,
  environment winning, and reports every override.
- `discordSettingsToEnvironment` projects public
  settings, including system actors, active body,
  user-session allowlists, voice, and activity;
  disabled booleans are omitted.
- `applyDiscordSettingsToEnvironment` fills only
  unset names so existing readers adopt the store
  without overwriting explicit process config.
- `parseDiscordActiveBody`,
  `resolveDiscordActiveBody`, and
  `isDiscordBodyActive` centralize the bot vs
  user-session mouth decision, defaulting safely
  to bot.
