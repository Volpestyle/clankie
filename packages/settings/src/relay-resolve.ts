import { envOverrideReaders } from "./env-override.ts";
import { RelaySettingsSchema, type RelaySettings } from "./schema.ts";

/**
 * Relay settings ↔ `CLANKIE_RELAY_URL`, following the exact contract of
 * {@link ./voice-resolve.ts}: environment wins on read, every override is
 * reported, and the projection fills only *unset* names so an env-driven
 * deployment keeps working unchanged.
 */
export interface ResolvedRelaySettings {
  settings: RelaySettings;
  /** Field names whose effective value came from the environment. */
  overriddenByEnvironment: string[];
}

export function resolveRelaySettings(
  stored: RelaySettings,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRelaySettings {
  const merged: Record<string, unknown> = { ...stored };
  const { overridden, takeString } = envOverrideReaders(env);
  takeString(merged, "url", "CLANKIE_RELAY_URL");
  return {
    settings: RelaySettingsSchema.parse(merged),
    overriddenByEnvironment: overridden,
  };
}

/**
 * Fill an unset `CLANKIE_RELAY_URL` from stored relay settings — call once at
 * startup, before anything reads it. Returns the names it filled for startup
 * logging.
 */
export function applyRelaySettingsToEnvironment(
  settings: RelaySettings,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const effective = resolveRelaySettings(settings, env).settings;
  const existing = env.CLANKIE_RELAY_URL;
  if (effective.url === undefined || (existing !== undefined && existing.length > 0)) return [];
  env.CLANKIE_RELAY_URL = effective.url;
  return ["CLANKIE_RELAY_URL"];
}
