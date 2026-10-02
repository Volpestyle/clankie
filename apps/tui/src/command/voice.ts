import {
  SettingsStore,
  defaultSettingsPath,
  resolveVoiceSettings,
  type VoiceSettings,
} from "@clankie/settings";

const USAGE =
  "Usage: clankie voice [status]\n       clankie voice model set MODEL_ID\n       clankie voice model clear";

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

/** Public, non-secret owner command boundary; never restarts or changes providers/voice IDs. */
export async function runVoiceCommand(
  args: readonly string[],
  options: VoiceCommandOptions = {},
): Promise<VoiceCommandResult> {
  const env = options.env ?? process.env;
  const store = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  let voice: VoiceSettings;
  if (args.length === 0 || (args.length === 1 && args[0] === "status")) {
    voice = (await store.load()).voice;
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
