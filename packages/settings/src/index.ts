export {
  AgentHostConnectionSchema,
  type AgentHostConnection,
  CaptainSettingsSchema,
  SkillsSettingsSchema,
  type SkillsSettings,
  ClankieSettingsSchema,
  DiscordSettingsSchema,
  EmailSettingsSchema,
  FLEET_MODEL_GUIDANCE,
  FLEET_MODEL_MODES,
  FLEET_SIZE_GUIDANCE,
  FLEET_SIZES,
  FleetSettingsSchema,
  GameplaySettingsSchema,
  MinecraftHostSchema,
  MinecraftConfiguredProfileSchema,
  MinecraftPublicEndpointSchema,
  MinecraftSettingsSchema,
  BrowserSettingsSchema,
  HerdrSettingsSchema,
  ExecutionConnectionSchema,
  HerdrSshTransportSchema,
  type HerdrSshTransport,
  ExecutionWorkspacesSchema,
  LinearWebhookSettingsSchema,
  LinearWakeSettingsSchema,
  type LinearWakeSettings,
  OauthAppsSettingsSchema,
  McpServerSchema,
  McpSettingsSchema,
  PersonaSettingsSchema,
  PublicGatewaySettingsSchema,
  HostSettingsSchema,
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
  type FleetModelMode,
  type FleetSettings,
  type FleetSize,
  type GameplaySettings,
  type MinecraftConfiguredProfile,
  type MinecraftSettings,
  type BrowserSettings,
  type HerdrSettings,
  type LinearWebhookSettings,
  type OauthAppsSettings,
  type McpServerSettings,
  type McpSettings,
  type PersonaSettings,
  type PublicGatewaySettings,
  type HostSettings,
  type RelaySettings,
  type VoiceSettings,
} from "./schema.ts";
export { MinecraftPlaySettingsSchema, type MinecraftPlaySettings } from "@clankie/protocol";
export {
  FleetAutonomyModeSchema,
  FleetAutonomySchema,
  AutonomySettingsSchema,
  FleetAutonomyOverridesSchema,
  ProjectAutonomySchema,
  FleetAutonomyPatchSchema,
  ProjectAutonomyPatchSchema,
  FLEET_AUTONOMY_DEFAULTS,
  FLEET_CLOSURE_GUIDANCE,
  FLEET_MACHINE_SETUP_GUIDANCE,
  FLEET_AUTONOMY_GUIDANCE,
  effectiveFleetAutonomy,
  type FleetAutonomyMode,
  type FleetAutonomy,
  type AutonomySettings,
  type FleetAutonomyOverrides,
  type ProjectAutonomy,
  type FleetAutonomyPatch,
  type ProjectAutonomyPatch,
} from "@clankie/protocol/autonomy";
export { discordAttachmentRoot } from "./attachments.ts";
export { characterNames, personaInstructions, type PersonaRegister } from "./persona.ts";
export { bundledSkills, projectSkillPlugin } from "./bundled-skills.ts";
export { clankieSkillRoots, mergedLeadershipSkills } from "./skill-roots.ts";
export { SERVICE_LOADOUT_ENV, serviceInLoadout } from "./loadout.ts";
export { SettingsStore, defaultSettingsPath } from "./store.ts";
export { linearFollowStatus, linearWakeMatches } from "./linear-follow.ts";
export {
  applyDiscordSettingsToEnvironment,
  discordSettingsToEnvironment,
  discordManagedGuildId,
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

export {
  registerCodexAccount,
  removeCodexAccount,
  codexAccounts,
  codexAccountStatus,
  selectCodexAccount,
  selectLiveCodexAccount,
  readCodexAccountStatus,
  codexRateLimit,
  type CodexAccount,
} from "./codex-accounts.ts";

export * from "./projects.ts";
export * from "./project-enrollment.ts";
export { ProjectsSettingsSchema, type ProjectsSettings } from "@clankie/protocol/projects";

export * from "./project-worktrees.ts";
export * from "./project-worktree-observer.ts";

export { DesktopSettingsSchema, desktopIsQuiet, type DesktopSettings } from "./desktop.ts";
