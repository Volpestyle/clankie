export {
  ClankieSettingsSchema,
  DiscordSettingsSchema,
  PersonaSettingsSchema,
  SETTINGS_SCHEMA_VERSION,
  assertNoSecretShapedValue,
  emptySettings,
  type ClankieSettings,
  type DiscordSettings,
  type PersonaSettings,
} from "./schema.ts";
export { characterNames, personaInstructions, type PersonaRegister } from "./persona.ts";
export { SettingsStore, defaultSettingsPath } from "./store.ts";
export {
  applyDiscordSettingsToEnvironment,
  discordSettingsToEnvironment,
  resolveDiscordSettings,
  type ResolvedDiscordSettings,
} from "./discord-resolve.ts";
