import { DiscordSettingsSchema, type DiscordSettings } from "./schema.ts";

/**
 * Merge stored settings with environment overrides.
 *
 * Precedence is **environment wins**, which is the opposite of how the
 * credential broker treats secrets (there, an env token is a hard error). The
 * asymmetry is intentional: a leaked secret is a security failure, while an
 * overridable non-secret is an operational convenience that keeps CI, one-off
 * runs, and container deployments working without a settings file.
 *
 * Every override is reported so the TUI and readiness output can show an
 * operator why a stored value is not the effective one — a silent override is
 * exactly the kind of thing that wastes an hour of debugging.
 */
export interface ResolvedDiscordSettings {
  settings: DiscordSettings;
  /** Field names whose effective value came from the environment. */
  overriddenByEnvironment: string[];
}

export function resolveDiscordSettings(
  stored: DiscordSettings,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDiscordSettings {
  const overridden: string[] = [];
  const merged: Record<string, unknown> = { ...stored };

  const takeString = (field: keyof DiscordSettings, name: string): void => {
    const value = env[name]?.trim();
    if (value === undefined || value.length === 0) return;
    merged[field] = value;
    overridden.push(name);
  };

  const takeList = (field: keyof DiscordSettings, name: string): void => {
    const value = env[name];
    if (value === undefined) return;
    merged[field] = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    overridden.push(name);
  };

  const takeBoolean = (field: keyof DiscordSettings, name: string): void => {
    const value = env[name]?.trim();
    if (value === undefined || value.length === 0) return;
    merged[field] = value === "true";
    overridden.push(name);
  };

  const takeInteger = (field: keyof DiscordSettings, name: string): void => {
    const value = env[name]?.trim();
    if (value === undefined || value.length === 0) return;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed)) return;
    merged[field] = parsed;
    overridden.push(name);
  };

  takeString("applicationId", "DISCORD_APPLICATION_ID");
  takeString("guildId", "DISCORD_GUILD_ID");
  takeList("ambientRoleIds", "DISCORD_AMBIENT_ROLE_IDS");
  takeList("ambientUserIds", "DISCORD_AMBIENT_USER_IDS");
  takeList("approvalRoleIds", "DISCORD_APPROVAL_ROLE_IDS");
  takeString("ownerUserId", "DISCORD_OWNER_USER_ID");

  takeBoolean("textIngressEnabled", "DISCORD_TEXT_INGRESS_ENABLED");
  takeList("ingressGuildIds", "DISCORD_INGRESS_GUILD_IDS");
  takeList("ingressChannelIds", "DISCORD_INGRESS_CHANNEL_IDS");
  takeString("ingressDmPolicy", "DISCORD_INGRESS_DM_POLICY");
  takeList("ingressDmUserIds", "DISCORD_INGRESS_DM_USER_IDS");
  takeInteger("ingressContextMessages", "DISCORD_INGRESS_CONTEXT_MESSAGES");

  takeList("presenceGuildIds", "DISCORD_PRESENCE_GUILD_IDS");
  takeList("presenceChannelIds", "DISCORD_PRESENCE_CHANNEL_IDS");

  takeBoolean("voiceEnabled", "DISCORD_VOICE_ENABLED");
  takeList("voiceGuildIds", "DISCORD_VOICE_GUILD_IDS");
  takeList("voiceChannelIds", "DISCORD_VOICE_CHANNEL_IDS");
  takeString("voiceChannelId", "DISCORD_VOICE_CHANNEL_ID");
  takeString("voiceJoinPolicy", "DISCORD_VOICE_JOIN_POLICY");

  takeString("activityApplicationIdGba", "DISCORD_ACTIVITY_APPLICATION_ID_GBA");

  return {
    settings: DiscordSettingsSchema.parse(merged),
    overriddenByEnvironment: overridden,
  };
}

/**
 * Project resolved settings back into the environment shape the bridge and
 * control plane already read, so adopting the store is a composition change
 * rather than a rewrite of every call site.
 */
/**
 * Fill unset environment variables from stored settings.
 *
 * This is the adoption seam: a process calls it once at startup, before any
 * existing `process.env.DISCORD_*` read, and every current call site keeps
 * working unchanged. Only *unset* names are filled, which preserves the
 * environment-wins precedence rule.
 *
 * Returns the names it filled so startup logging can show what came from the
 * settings file rather than the shell.
 */
export function applyDiscordSettingsToEnvironment(
  settings: DiscordSettings,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const applied: string[] = [];
  for (const [name, value] of Object.entries(discordSettingsToEnvironment(settings))) {
    const existing = env[name];
    if (existing !== undefined && existing.length > 0) continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}

export function discordSettingsToEnvironment(settings: DiscordSettings): Record<string, string> {
  const env: Record<string, string> = {};
  const put = (name: string, value: string | undefined): void => {
    if (value !== undefined && value.length > 0) env[name] = value;
  };
  const putList = (name: string, values: readonly string[]): void => {
    if (values.length > 0) env[name] = values.join(",");
  };

  put("DISCORD_APPLICATION_ID", settings.applicationId);
  put("DISCORD_GUILD_ID", settings.guildId);
  putList("DISCORD_AMBIENT_ROLE_IDS", settings.ambientRoleIds);
  putList("DISCORD_AMBIENT_USER_IDS", settings.ambientUserIds);
  putList("DISCORD_APPROVAL_ROLE_IDS", settings.approvalRoleIds);
  put("DISCORD_OWNER_USER_ID", settings.ownerUserId);

  if (settings.textIngressEnabled) env["DISCORD_TEXT_INGRESS_ENABLED"] = "true";
  putList("DISCORD_INGRESS_GUILD_IDS", settings.ingressGuildIds);
  putList("DISCORD_INGRESS_CHANNEL_IDS", settings.ingressChannelIds);
  put("DISCORD_INGRESS_DM_POLICY", settings.ingressDmPolicy);
  putList("DISCORD_INGRESS_DM_USER_IDS", settings.ingressDmUserIds);
  env["DISCORD_INGRESS_CONTEXT_MESSAGES"] = String(settings.ingressContextMessages);

  putList("DISCORD_PRESENCE_GUILD_IDS", settings.presenceGuildIds);
  putList("DISCORD_PRESENCE_CHANNEL_IDS", settings.presenceChannelIds);

  if (settings.voiceEnabled) env["DISCORD_VOICE_ENABLED"] = "true";
  putList("DISCORD_VOICE_GUILD_IDS", settings.voiceGuildIds);
  putList("DISCORD_VOICE_CHANNEL_IDS", settings.voiceChannelIds);
  put("DISCORD_VOICE_CHANNEL_ID", settings.voiceChannelId);
  put("DISCORD_VOICE_JOIN_POLICY", settings.voiceJoinPolicy);

  put("DISCORD_ACTIVITY_APPLICATION_ID_GBA", settings.activityApplicationIdGba);
  return env;
}
