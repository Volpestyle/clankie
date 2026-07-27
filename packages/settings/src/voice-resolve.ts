import { VoiceSettingsSchema, type VoiceSettings } from "./schema.ts";

/**
 * Voice-runtime settings ↔ `CLANKIE_VOICE_*` environment, following the exact
 * contract of {@link ./discord-resolve.ts}: environment wins on read, every
 * override is reported, and the projection fills only *unset* names so
 * existing env-driven deployments keep working unchanged.
 */
export interface ResolvedVoiceSettings {
  settings: VoiceSettings;
  /** Field names whose effective value came from the environment. */
  overriddenByEnvironment: string[];
}

export function resolveVoiceSettings(
  stored: VoiceSettings,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedVoiceSettings {
  const overridden: string[] = [];
  const merged: Record<string, unknown> = { ...stored };

  const takeString = (field: keyof VoiceSettings, name: string): void => {
    const value = env[name]?.trim();
    if (value === undefined || value.length === 0) return;
    merged[field] = value;
    overridden.push(name);
  };

  takeString("ttsProvider", "CLANKIE_VOICE_TTS_PROVIDER");
  takeString("openAiVoice", "CLANKIE_VOICE_REALTIME_VOICE");
  takeString("elevenLabsVoiceId", "CLANKIE_VOICE_ELEVENLABS_VOICE_ID");
  takeString("elevenLabsModelId", "CLANKIE_VOICE_ELEVENLABS_MODEL_ID");

  return {
    settings: VoiceSettingsSchema.parse(merged),
    overriddenByEnvironment: overridden,
  };
}

/**
 * Fill unset environment variables from stored voice settings — the same
 * adoption seam as {@link ./discord-resolve.ts}: call once at startup, before
 * anything reads `CLANKIE_VOICE_*`, and the existing env parser keeps working
 * unchanged. Returns the names it filled for startup logging.
 */
export function applyVoiceSettingsToEnvironment(
  settings: VoiceSettings,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const applied: string[] = [];
  for (const [name, value] of Object.entries(voiceSettingsToEnvironment(settings))) {
    const existing = env[name];
    if (existing !== undefined && existing.length > 0) continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}

export function voiceSettingsToEnvironment(settings: VoiceSettings): Record<string, string> {
  const env: Record<string, string> = {};
  if (settings.openAiVoice !== undefined && settings.openAiVoice.length > 0) {
    env["CLANKIE_VOICE_REALTIME_VOICE"] = settings.openAiVoice;
  }
  // The default provider is omitted, and the ElevenLabs identifiers are
  // projected only under their provider — the env parser treats a set-but-
  // ignored identifier as drift and fails loudly, and this projection must
  // never manufacture that state from a stored-but-inactive configuration.
  if (settings.ttsProvider === "elevenlabs") {
    env["CLANKIE_VOICE_TTS_PROVIDER"] = "elevenlabs";
    if (settings.elevenLabsVoiceId !== undefined) {
      env["CLANKIE_VOICE_ELEVENLABS_VOICE_ID"] = settings.elevenLabsVoiceId;
    }
    if (settings.elevenLabsModelId !== undefined) {
      env["CLANKIE_VOICE_ELEVENLABS_MODEL_ID"] = settings.elevenLabsModelId;
    }
  }
  return env;
}
