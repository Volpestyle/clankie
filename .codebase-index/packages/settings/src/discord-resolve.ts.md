# packages/settings/src/discord-resolve.ts

Discord settings ↔ environment. Three exports:

- `resolveDiscordSettings(stored, env)` — merges
  stored settings with `DISCORD_*` /
  `CLANKIE_ACTIVITY_*` env variables,
  **environment wins** (the opposite of the
  broker's secret rule, deliberately), and every
  override is reported in
  `overriddenByEnvironment` so the TUI can show
  why a stored value is not the effective one.
- `applyDiscordSettingsToEnvironment(settings,
env)` — the adoption seam: fills only _unset_
  env names at startup so every existing
  `process.env.DISCORD_*` read keeps working;
  returns what it filled for startup logging.
- `discordSettingsToEnvironment(settings)` — the
  pure projection; disabled booleans are omitted
  rather than emitted as "false" so a stale
  export cannot enable a plane.
