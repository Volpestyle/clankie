import { envOverrideReaders } from "./env-override.ts";
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
  const merged: Record<string, unknown> = { ...stored };
  const { overridden, takeString, takeList, takeBoolean, takeInteger } = envOverrideReaders(env);

  takeString(merged, "applicationId", "DISCORD_APPLICATION_ID");
  takeString(merged, "guildId", "DISCORD_GUILD_ID");
  takeString(merged, "swarmGuildId", "DISCORD_SWARM_GUILD_ID");
  takeList(merged, "ambientRoleIds", "DISCORD_AMBIENT_ROLE_IDS");
  takeList(merged, "ambientUserIds", "DISCORD_AMBIENT_USER_IDS");
  takeList(merged, "approvalRoleIds", "DISCORD_APPROVAL_ROLE_IDS");
  takeString(merged, "ownerUserId", "DISCORD_OWNER_USER_ID");
  takeList(merged, "systemActorUserIds", "DISCORD_SYSTEM_ACTOR_USER_IDS");
  takeList(merged, "systemActorGuildIds", "DISCORD_SYSTEM_ACTOR_GUILD_IDS");
  takeList(merged, "systemActorChannelIds", "DISCORD_SYSTEM_ACTOR_CHANNEL_IDS");

  takeBoolean(merged, "textIngressEnabled", "DISCORD_TEXT_INGRESS_ENABLED");
  takeList(merged, "ingressGuildIds", "DISCORD_INGRESS_GUILD_IDS");
  takeList(merged, "ingressChannelIds", "DISCORD_INGRESS_CHANNEL_IDS");
  takeString(merged, "ingressDmPolicy", "DISCORD_INGRESS_DM_POLICY");
  takeList(merged, "ingressDmUserIds", "DISCORD_INGRESS_DM_USER_IDS");
  takeInteger(merged, "ingressContextMessages", "DISCORD_INGRESS_CONTEXT_MESSAGES");

  takeList(merged, "presenceGuildIds", "DISCORD_PRESENCE_GUILD_IDS");
  takeList(merged, "presenceChannelIds", "DISCORD_PRESENCE_CHANNEL_IDS");

  takeBoolean(merged, "voiceEnabled", "DISCORD_VOICE_ENABLED");
  takeList(merged, "voiceGuildIds", "DISCORD_VOICE_GUILD_IDS");
  takeList(merged, "voiceChannelIds", "DISCORD_VOICE_CHANNEL_IDS");
  takeString(merged, "voiceChannelId", "DISCORD_VOICE_CHANNEL_ID");
  takeString(merged, "voiceJoinPolicy", "DISCORD_VOICE_JOIN_POLICY");
  takeString(merged, "voiceConsentPolicy", "DISCORD_VOICE_CONSENT_POLICY");
  takeBoolean(merged, "voiceTranscriptLoggingEnabled", "DISCORD_VOICE_TRANSCRIPT_LOGGING_ENABLED");
  const activeBody = env.DISCORD_ACTIVE_BODY?.trim();
  if (activeBody === "bot" || activeBody === "user_session") {
    merged.activeBody = activeBody;
    overridden.push("DISCORD_ACTIVE_BODY");
  }

  takeBoolean(merged, "userSessionEnabled", "DISCORD_USER_SESSION_ENABLED");
  takeList(merged, "userSessionGuildIds", "DISCORD_USER_SESSION_GUILD_IDS");
  takeList(merged, "userSessionChannelIds", "DISCORD_USER_SESSION_CHANNEL_IDS");
  takeBoolean(merged, "userSessionVoiceEnabled", "DISCORD_USER_SESSION_VOICE_ENABLED");
  takeList(merged, "userSessionVoiceChannelIds", "DISCORD_USER_SESSION_VOICE_CHANNEL_IDS");
  takeString(merged, "userSessionDmPolicy", "DISCORD_USER_SESSION_DM_POLICY");
  takeList(merged, "userSessionDmUserIds", "DISCORD_USER_SESSION_DM_USER_IDS");

  takeString(merged, "activityApplicationIdGba", "DISCORD_ACTIVITY_APPLICATION_ID_GBA");
  takeString(merged, "activityTunnelName", "CLANKIE_ACTIVITY_TUNNEL_NAME");
  takeString(merged, "activityTunnelHostname", "CLANKIE_ACTIVITY_TUNNEL_HOSTNAME");

  return {
    settings: DiscordSettingsSchema.parse(merged),
    overriddenByEnvironment: overridden,
  };
}

export type DiscordActiveBody = DiscordSettings["activeBody"];

export function parseDiscordActiveBody(value: string | undefined): DiscordActiveBody {
  return value === "user_session" ? "user_session" : "bot";
}

export function resolveDiscordActiveBody(env: NodeJS.ProcessEnv = process.env): DiscordActiveBody {
  return parseDiscordActiveBody(env.DISCORD_ACTIVE_BODY);
}

export function isDiscordBodyActive(body: DiscordActiveBody, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveDiscordActiveBody(env) === body;
}

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
  put("DISCORD_SWARM_GUILD_ID", settings.swarmGuildId);
  putList("DISCORD_AMBIENT_ROLE_IDS", settings.ambientRoleIds);
  putList("DISCORD_AMBIENT_USER_IDS", settings.ambientUserIds);
  putList("DISCORD_APPROVAL_ROLE_IDS", settings.approvalRoleIds);
  put("DISCORD_OWNER_USER_ID", settings.ownerUserId);
  putList("DISCORD_SYSTEM_ACTOR_USER_IDS", settings.systemActorUserIds);
  putList("DISCORD_SYSTEM_ACTOR_GUILD_IDS", settings.systemActorGuildIds);
  putList("DISCORD_SYSTEM_ACTOR_CHANNEL_IDS", settings.systemActorChannelIds);

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
  put("DISCORD_VOICE_CONSENT_POLICY", settings.voiceConsentPolicy);
  if (settings.voiceTranscriptLoggingEnabled) {
    env["DISCORD_VOICE_TRANSCRIPT_LOGGING_ENABLED"] = "true";
  }
  env["DISCORD_ACTIVE_BODY"] = settings.activeBody;
  if (settings.userSessionEnabled) env["DISCORD_USER_SESSION_ENABLED"] = "true";
  putList("DISCORD_USER_SESSION_GUILD_IDS", settings.userSessionGuildIds);
  putList("DISCORD_USER_SESSION_CHANNEL_IDS", settings.userSessionChannelIds);
  if (settings.userSessionVoiceEnabled) env["DISCORD_USER_SESSION_VOICE_ENABLED"] = "true";
  putList("DISCORD_USER_SESSION_VOICE_CHANNEL_IDS", settings.userSessionVoiceChannelIds);
  put("DISCORD_USER_SESSION_DM_POLICY", settings.userSessionDmPolicy);
  putList("DISCORD_USER_SESSION_DM_USER_IDS", settings.userSessionDmUserIds);

  put("DISCORD_ACTIVITY_APPLICATION_ID_GBA", settings.activityApplicationIdGba);
  put("CLANKIE_ACTIVITY_TUNNEL_NAME", settings.activityTunnelName);
  put("CLANKIE_ACTIVITY_TUNNEL_HOSTNAME", settings.activityTunnelHostname);
  return env;
}
