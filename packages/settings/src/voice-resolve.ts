import { envOverrideReaders } from "./env-override.ts";
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
  const merged: Record<string, unknown> = { ...stored };
  const { overridden, takeString } = envOverrideReaders(env);

  takeString(merged, "realtimeProvider", "CLANKIE_VOICE_REALTIME_PROVIDER");
  takeString(merged, "ttsProvider", "CLANKIE_VOICE_TTS_PROVIDER");
  const provider = merged.realtimeProvider === "xai" ? "xai" : "openai";
  if (provider === "xai") {
    takeString(merged, "xAiRealtimeModel", "CLANKIE_VOICE_REALTIME_MODEL");
    takeString(merged, "xAiVoice", "CLANKIE_VOICE_REALTIME_VOICE");
    takeString(merged, "xAiReasoningEffort", "CLANKIE_VOICE_XAI_REASONING_EFFORT");
  } else {
    takeString(merged, "openAiRealtimeModel", "CLANKIE_VOICE_REALTIME_MODEL");
    takeString(merged, "openAiTranscribeModel", "CLANKIE_VOICE_TRANSCRIBE_MODEL");
    takeString(merged, "openAiVoice", "CLANKIE_VOICE_REALTIME_VOICE");
  }
  takeString(merged, "elevenLabsVoiceId", "CLANKIE_VOICE_ELEVENLABS_VOICE_ID");
  takeString(merged, "elevenLabsModelId", "CLANKIE_VOICE_ELEVENLABS_MODEL_ID");

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
  const effective = resolveVoiceSettings(settings, env).settings;
  for (const [name, value] of Object.entries(voiceSettingsToEnvironment(effective))) {
    const existing = env[name];
    if (existing !== undefined && existing.length > 0) continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}

export function voiceSettingsToEnvironment(settings: VoiceSettings): Record<string, string> {
  const env: Record<string, string> = {};
  if (settings.realtimeProvider === "xai") {
    env["CLANKIE_VOICE_REALTIME_PROVIDER"] = "xai";
    if (settings.xAiRealtimeModel !== undefined) {
      env["CLANKIE_VOICE_REALTIME_MODEL"] = settings.xAiRealtimeModel;
    }
    if (settings.xAiVoice !== undefined) {
      env["CLANKIE_VOICE_REALTIME_VOICE"] = settings.xAiVoice;
    }
    env["CLANKIE_VOICE_XAI_REASONING_EFFORT"] = settings.xAiReasoningEffort;
  } else {
    if (settings.openAiRealtimeModel !== undefined) {
      env["CLANKIE_VOICE_REALTIME_MODEL"] = settings.openAiRealtimeModel;
    }
    if (settings.openAiTranscribeModel !== undefined) {
      env["CLANKIE_VOICE_TRANSCRIBE_MODEL"] = settings.openAiTranscribeModel;
    }
    if (settings.openAiVoice !== undefined && settings.openAiVoice.length > 0) {
      env["CLANKIE_VOICE_REALTIME_VOICE"] = settings.openAiVoice;
    }
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
