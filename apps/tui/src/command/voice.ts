import { SettingsStore, defaultSettingsPath, type VoiceSettings } from "@clankie/settings";

import { OwnerVoiceSnapshotSchema } from "@clankie/protocol/owner-settings";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

const USAGE =
  "Usage: clankie voice [status]\n       clankie voice brain set openai|xai|anthropic [MODEL_ID]\n       clankie voice brain model clear\n       clankie voice model set MODEL_ID\n       clankie voice model clear";

export interface VoiceCommandOptions extends OwnerSettingsApiOptions {
  readonly settings?: SettingsStore;
  readonly expectedRevision?: string;
}

export interface VoiceCommandResult {
  readonly ok: true;
  readonly voice: VoiceSettings;
  readonly effectiveVoice: VoiceSettings;
  readonly overriddenByEnvironment: readonly string[];
  readonly settingsFile: string;
  readonly restart: string;
  readonly revision: string;
}

/** Public, non-secret owner command boundary; never restarts or writes credentials. */
export async function runVoiceCommand(
  args: readonly string[],
  options: VoiceCommandOptions = {},
): Promise<VoiceCommandResult> {
  const env = options.env ?? process.env;
  const store = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  const api = await ownerSettingsApi(options);
  let snapshot = await api.get("/v1/operator/voice", OwnerVoiceSnapshotSchema);
  let voice = snapshot.voice;
  if (args.length === 0 || (args.length === 1 && args[0] === "status")) {
    // Status is read from the same host that owns the settings.
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
    const next = { ...voice };
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
    voice = next;
  } else {
    const clear = args.length === 2 && args[0] === "model" && args[1] === "clear";
    const set = args.length === 3 && args[0] === "model" && args[1] === "set";
    if (!clear && !set) throw new Error(USAGE);
    const model = args[2]?.trim();
    if (set && (model === undefined || !/^[\w-]{1,128}$/u.test(model))) {
      throw new Error("ElevenLabs model id must be 1–128 letters, digits, underscores or hyphens.");
    }
    if (voice.ttsProvider !== "elevenlabs") {
      throw new Error("Select ElevenLabs and a voice ID with /voice in the console first.");
    }
    const next = { ...voice };
    if (clear) delete next.elevenLabsModelId;
    else next.elevenLabsModelId = model;
    voice = next;
  }
  if (!(args.length === 0 || (args.length === 1 && args[0] === "status"))) {
    snapshot = await api.write(
      "/v1/operator/voice",
      { expectedRevision: options.expectedRevision ?? snapshot.revision, voice },
      OwnerVoiceSnapshotSchema,
    );
  }
  voice = snapshot.voice;
  return {
    ok: true,
    voice,
    effectiveVoice: snapshot.effectiveVoice,
    overriddenByEnvironment: snapshot.overriddenByEnvironment,
    settingsFile: store.path,
    revision: snapshot.revision,
    restart: "clankie restart",
  };
}
