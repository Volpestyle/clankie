export {
  CaptainSettingsSchema,
  ClankieSettingsSchema,
  DiscordSettingsSchema,
  EmailSettingsSchema,
  GameplaySettingsSchema,
  HerdrSettingsSchema,
  McpServerSchema,
  McpSettingsSchema,
  PersonaSettingsSchema,
  RelaySettingsSchema,
  SETTINGS_SCHEMA_VERSION,
  VoiceSettingsSchema,
  assertNoSecretShapedValue,
  dropRetiredSettings,
  emptySettings,
  type CaptainSettings,
  type ClankieSettings,
  type DiscordSettings,
  type EmailSettings,
  type GameplaySettings,
  type HerdrSettings,
  type McpServerSettings,
  type McpSettings,
  type PersonaSettings,
  type RelaySettings,
  type VoiceSettings,
} from "./schema.ts";
export { discordAttachmentRoot } from "./attachments.ts";
export { characterNames, personaInstructions, type PersonaRegister } from "./persona.ts";
export { SettingsStore, defaultSettingsPath } from "./store.ts";
export {
  applyDiscordSettingsToEnvironment,
  discordSettingsToEnvironment,
  isDiscordBodyActive,
  parseDiscordActiveBody,
  resolveDiscordActiveBody,
  resolveDiscordSettings,
  type DiscordActiveBody,
  type ResolvedDiscordSettings,
} from "./discord-resolve.ts";
export { applyRelaySettingsToEnvironment, resolveRelaySettings } from "./relay-resolve.ts";
export {
  applyVoiceSettingsToEnvironment,
  resolveVoiceSettings,
  voiceSettingsToEnvironment,
  type ResolvedVoiceSettings,
} from "./voice-resolve.ts";

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
