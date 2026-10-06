import {
  SettingsStore,
  defaultSettingsPath,
  resolveVoiceSettings,
  type VoiceSettings,
} from "@clankie/settings";

const USAGE =
  "Usage: clankie voice [status]\n       clankie voice brain set openai|xai|anthropic [MODEL_ID]\n       clankie voice brain model clear\n       clankie voice model set MODEL_ID\n       clankie voice model clear";

export interface VoiceCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
}

export interface VoiceCommandResult {
  readonly ok: true;
  readonly voice: VoiceSettings;
  readonly effectiveVoice: VoiceSettings;
  readonly overriddenByEnvironment: readonly string[];
  readonly settingsFile: string;
  readonly restart: string;
}

/** Public, non-secret owner command boundary; never restarts or writes credentials. */
export async function runVoiceCommand(
  args: readonly string[],
  options: VoiceCommandOptions = {},
): Promise<VoiceCommandResult> {
  const env = options.env ?? process.env;
  const store = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  let voice: VoiceSettings;
  if (args.length === 0 || (args.length === 1 && args[0] === "status")) {
    voice = (await store.load()).voice;
  } else if (args[0] === "brain") {
    const clear = args.length === 3 && args[1] === "model" && args[2] === "clear";
    const set = (args.length === 3 || args.length === 4) && args[1] === "set";
    const provider = args[2];
    if (!clear && (!set || !["openai", "xai", "anthropic"].includes(provider ?? ""))) {
      throw new Error(USAGE);
    }
    const model = args[3]?.trim();
    if (model !== undefined && !/^[\w.-]{1,128}$/u.test(model)) {
      throw new Error("Voice brain model id must be 1–128 letters, digits, dots, underscores or hyphens.");
    }
    voice = (
      await store.update((current) => {
        const next = { ...current.voice };
        if (clear) {
          if (next.realtimeProvider === "anthropic") delete next.anthropicModel;
          else if (next.realtimeProvider === "xai") delete next.xAiRealtimeModel;
          else delete next.openAiRealtimeModel;
        } else if (provider === "anthropic") {
          if (next.elevenLabsVoiceId === undefined) {
            throw new Error("Anthropic voice needs an ElevenLabs voice ID; configure it with /voice first.");
          }
          next.realtimeProvider = "anthropic";
          next.ttsProvider = "elevenlabs";
          if (model !== undefined) next.anthropicModel = model;
        } else if (provider === "xai") {
          next.realtimeProvider = "xai";
          next.ttsProvider = "openai";
          if (model !== undefined) next.xAiRealtimeModel = model;
        } else {
          next.realtimeProvider = "openai";
          if (model !== undefined) next.openAiRealtimeModel = model;
        }
        // Environment overrides can make a valid stored candidate unusable.
        // Validate before SettingsStore persists, so a refusal never saves it.
        resolveVoiceSettings(next, env);
        return { ...current, voice: next };
      })
    ).voice;
  } else {
    const clear = args.length === 2 && args[0] === "model" && args[1] === "clear";
    const set = args.length === 3 && args[0] === "model" && args[1] === "set";
    if (!clear && !set) throw new Error(USAGE);
    const model = args[2]?.trim();
    if (set && (model === undefined || !/^[\w-]{1,128}$/u.test(model))) {
      throw new Error("ElevenLabs model id must be 1–128 letters, digits, underscores or hyphens.");
    }
    voice = (
      await store.update((current) => {
        if (current.voice.ttsProvider !== "elevenlabs") {
          throw new Error("Select ElevenLabs and a voice ID with /voice in the console first.");
        }
        const next = { ...current.voice };
        if (clear) delete next.elevenLabsModelId;
        else next.elevenLabsModelId = model;
        resolveVoiceSettings(next, env);
        return { ...current, voice: next };
      })
    ).voice;
  }
  const resolved = resolveVoiceSettings(voice, env);
  return {
    ok: true,
    voice,
    effectiveVoice: resolved.settings,
    overriddenByEnvironment: resolved.overriddenByEnvironment,
    settingsFile: store.path,
    restart: "clankie restart",
  };
}
