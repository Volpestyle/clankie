import type { DiscordVoiceEvidence } from "@clankie/protocol";
import type { DiscordBridgeReceipt } from "./receipt-store.ts";
import {
  openRealtimeConversationSession,
  openRealtimeTranscriptionSession,
  openXaiStreamingTranscriptionSession,
  XAI_REALTIME_BASE_URL,
  type RealtimeSocketFactory,
  type RealtimeTimers,
} from "./realtime-session.ts";
import { openElevenLabsTtsSession } from "./elevenlabs-tts.ts";
import { openExternalVoiceConversation } from "./external-voice.ts";
import { DEFAULT_DECAY_WINDOW_MS } from "./voice-floor.ts";
import type {
  DiscordVoiceRealtimePorts,
  DiscordVoiceBriefing,
  DiscordVoiceBriefingRequest,
  LookAtScreenResult,
  VoiceConversationOpenInput,
  VoiceTranscriptionHandlers,
} from "./voice-session.ts";

export const DEFAULT_VOICE_REALTIME_MODEL = "gpt-realtime-2.1";
export const DEFAULT_VOICE_TRANSCRIBE_MODEL = "gpt-realtime-whisper";
export const DEFAULT_VOICE_REALTIME_VOICE = "marin";
export const DEFAULT_XAI_VOICE_REALTIME_MODEL = "grok-voice-think-fast-2.0";
export const DEFAULT_XAI_VOICE_REALTIME_VOICE = "eve";
export const DEFAULT_VOICE_TRUNCATION_RETENTION = 0.7;
export const DEFAULT_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT = 12_000;
export const DEFAULT_VOICE_IDLE_LEAVE_MS = 15 * 60_000;
export const MAX_VOICE_IDLE_LEAVE_MS = 24 * 60 * 60_000;

export interface VoiceRealtimeBaseEnvConfig {
  readonly realtimeProvider: VoiceRealtimeProvider;
  readonly realtimeModel: string;
  readonly transcribeModel: string;
  readonly voice: string;
  readonly xaiReasoningEffort?: XaiVoiceReasoningEffort;
  readonly language?: string;
  readonly truncationRetentionRatio: number;
  readonly postInstructionsTokenLimit: number;
  readonly sessionLifetimeMs?: number;
  readonly decayWindowMs: number;
  readonly idleLeaveMs: number;
}

export const VOICE_REALTIME_PROVIDERS = ["openai", "xai"] as const;
export type VoiceRealtimeProvider = (typeof VOICE_REALTIME_PROVIDERS)[number];
export const DEFAULT_VOICE_REALTIME_PROVIDER: VoiceRealtimeProvider = "openai";
export const XAI_VOICE_REASONING_EFFORTS = ["high", "none"] as const;
export type XaiVoiceReasoningEffort = (typeof XAI_VOICE_REASONING_EFFORTS)[number];

export function parseVoiceRealtimeBaseEnv(env: NodeJS.ProcessEnv): VoiceRealtimeBaseEnvConfig {
  const realtimeProvider = enumEnv(
    env,
    "CLANKIE_VOICE_REALTIME_PROVIDER",
    VOICE_REALTIME_PROVIDERS,
    DEFAULT_VOICE_REALTIME_PROVIDER,
  );
  const language = env.CLANKIE_VOICE_STT_LANGUAGE;
  const sessionLifetimeMs = optionalIntegerEnv(
    env,
    "CLANKIE_VOICE_SESSION_LIFETIME_MS",
    10_000,
    4 * 60 * 60_000,
  );
  return {
    realtimeProvider,
    realtimeModel: nonEmptyEnv(
      env,
      "CLANKIE_VOICE_REALTIME_MODEL",
      realtimeProvider === "xai" ? DEFAULT_XAI_VOICE_REALTIME_MODEL : DEFAULT_VOICE_REALTIME_MODEL,
    ),
    transcribeModel: nonEmptyEnv(env, "CLANKIE_VOICE_TRANSCRIBE_MODEL", DEFAULT_VOICE_TRANSCRIBE_MODEL),
    voice: nonEmptyEnv(
      env,
      "CLANKIE_VOICE_REALTIME_VOICE",
      realtimeProvider === "xai" ? DEFAULT_XAI_VOICE_REALTIME_VOICE : DEFAULT_VOICE_REALTIME_VOICE,
    ),
    ...(realtimeProvider === "xai"
      ? {
          xaiReasoningEffort: enumEnv(
            env,
            "CLANKIE_VOICE_XAI_REASONING_EFFORT",
            XAI_VOICE_REASONING_EFFORTS,
            "high",
          ),
        }
      : {}),
    ...(language === undefined ? {} : { language }),
    truncationRetentionRatio: ratioEnv(
      env,
      "CLANKIE_VOICE_TRUNCATION_RETENTION",
      DEFAULT_VOICE_TRUNCATION_RETENTION,
    ),
    postInstructionsTokenLimit:
      optionalIntegerEnv(env, "CLANKIE_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT", 1_000, 128_000) ??
      DEFAULT_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT,
    ...(sessionLifetimeMs === undefined ? {} : { sessionLifetimeMs }),
    decayWindowMs:
      optionalIntegerEnv(env, "CLANKIE_VOICE_DECAY_WINDOW_MS", 1, Number.MAX_SAFE_INTEGER) ??
      DEFAULT_DECAY_WINDOW_MS,
    idleLeaveMs:
      optionalIntegerEnv(env, "CLANKIE_VOICE_IDLE_LEAVE_MS", 1, MAX_VOICE_IDLE_LEAVE_MS) ??
      DEFAULT_VOICE_IDLE_LEAVE_MS,
  };
}

function enumEnv<const T extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  name: string,
  values: T,
  fallback: T[number],
): T[number] {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value.length === 0) return fallback;
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  return match;
}

function nonEmptyEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${name} must be non-empty when set`);
  return trimmed;
}

function ratioEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${name} must be a ratio within (0, 1]`);
  }
  return parsed;
}

function optionalIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum.toString()} and ${maximum.toString()}`);
  }
  return parsed;
}

/**
 * Who synthesizes Clankie's replies. The historical `openai` value means the
 * selected realtime provider's native voice; it remains stable on the wire so
 * existing settings and environments keep working.
 */
export const VOICE_TTS_PROVIDERS = ["openai", "elevenlabs"] as const;
export type VoiceTtsProvider = (typeof VOICE_TTS_PROVIDERS)[number];
export const DEFAULT_VOICE_TTS_PROVIDER: VoiceTtsProvider = "openai";

const RETIRED_VOICE_ENV: Readonly<Record<string, string>> = {
  CLANKIE_VOICE_STT_MODEL: "use CLANKIE_VOICE_TRANSCRIBE_MODEL",
  CLANKIE_VOICE_TTS_MODEL: "use CLANKIE_VOICE_REALTIME_MODEL",
  CLANKIE_VOICE_TTS_VOICE: "use CLANKIE_VOICE_REALTIME_VOICE",
  CLANKIE_VOICE_VOLITION_MODEL:
    "there is no separate volition model — his own realtime session decides whether to speak up",
};

export interface VoiceRealtimeEnvConfig extends VoiceRealtimeBaseEnvConfig {
  readonly ttsProvider: VoiceTtsProvider;
  readonly elevenLabsVoiceId?: string;
  readonly elevenLabsModelId?: string;
}

export function parseVoiceRealtimeEnv(env: NodeJS.ProcessEnv): VoiceRealtimeEnvConfig {
  const retired = Object.entries(RETIRED_VOICE_ENV).filter(([name]) => env[name] !== undefined);
  if (retired.length > 0) {
    throw new Error(
      `Retired voice configuration is set and would be ignored: ${retired
        .map(([name, guidance]) => `${name} (${guidance})`)
        .join(", ")}.`,
    );
  }
  const base = parseVoiceRealtimeBaseEnv(env);
  const ttsProvider = enumEnv(
    env,
    "CLANKIE_VOICE_TTS_PROVIDER",
    VOICE_TTS_PROVIDERS,
    DEFAULT_VOICE_TTS_PROVIDER,
  );
  const elevenLabsVoiceId = env.CLANKIE_VOICE_ELEVENLABS_VOICE_ID?.trim();
  const elevenLabsModelId = env.CLANKIE_VOICE_ELEVENLABS_MODEL_ID?.trim();
  if (ttsProvider === "elevenlabs") {
    if (elevenLabsVoiceId === undefined || elevenLabsVoiceId.length === 0) {
      throw new Error(
        "CLANKIE_VOICE_ELEVENLABS_VOICE_ID is required when CLANKIE_VOICE_TTS_PROVIDER=elevenlabs",
      );
    }
    if (base.realtimeProvider !== "openai") {
      throw new Error("ElevenLabs speech output currently requires CLANKIE_VOICE_REALTIME_PROVIDER=openai");
    }
  } else if (elevenLabsVoiceId !== undefined || elevenLabsModelId !== undefined) {
    throw new Error(
      "CLANKIE_VOICE_ELEVENLABS_VOICE_ID and CLANKIE_VOICE_ELEVENLABS_MODEL_ID require " +
        "CLANKIE_VOICE_TTS_PROVIDER=elevenlabs",
    );
  }
  if (base.realtimeProvider === "xai" && env.CLANKIE_VOICE_TRANSCRIBE_MODEL !== undefined) {
    throw new Error(
      "CLANKIE_VOICE_TRANSCRIBE_MODEL is OpenAI-only; xAI streaming speech-to-text has no model selector",
    );
  }
  if (
    base.realtimeProvider === "xai" &&
    (env.CLANKIE_VOICE_TRUNCATION_RETENTION !== undefined ||
      env.CLANKIE_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT !== undefined)
  ) {
    throw new Error(
      "CLANKIE_VOICE_TRUNCATION_RETENTION and CLANKIE_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT are OpenAI-only",
    );
  }
  return {
    ...base,
    ttsProvider,
    ...(ttsProvider === "elevenlabs" && elevenLabsVoiceId !== undefined ? { elevenLabsVoiceId } : {}),
    ...(ttsProvider === "elevenlabs" && elevenLabsModelId !== undefined && elevenLabsModelId.length > 0
      ? { elevenLabsModelId }
      : {}),
  };
}

export interface VoiceRealtimePortsInput {
  /** Broker-resolved key for the selected realtime provider. */
  readonly apiKey: string;
  readonly elevenLabsApiKey?: string;
  readonly config: VoiceRealtimeEnvConfig;
  readonly socketFactory?: RealtimeSocketFactory;
  readonly timers?: RealtimeTimers;
}

/** Shared provider composition for both Discord bodies. */
export function createVoiceRealtimePorts(input: VoiceRealtimePortsInput): DiscordVoiceRealtimePorts {
  const { apiKey, elevenLabsApiKey, config, socketFactory, timers } = input;
  if (config.ttsProvider === "elevenlabs" && elevenLabsApiKey === undefined) {
    throw new Error(
      "The elevenlabs TTS provider requires the brokered elevenlabs credential. " +
        "Store the ElevenLabs API key under provider elevenlabs.",
    );
  }
  const common = {
    apiKey,
    ...(socketFactory === undefined ? {} : { socketFactory }),
    ...(timers === undefined ? {} : { timers }),
    ...(config.sessionLifetimeMs === undefined ? {} : { maxLifetimeMs: config.sessionLifetimeMs }),
  };
  const openConversation =
    config.ttsProvider === "elevenlabs" && elevenLabsApiKey !== undefined
      ? (open: VoiceConversationOpenInput) =>
          openExternalVoiceConversation(
            open,
            {
              openRealtime: (handlers) =>
                openRealtimeConversationSession({
                  ...common,
                  model: config.realtimeModel,
                  outputModality: "text",
                  instructions: open.instructions,
                  truncationRetentionRatio: config.truncationRetentionRatio,
                  postInstructionsTokenLimit: config.postInstructionsTokenLimit,
                  onAudioDelta: open.onAudioDelta,
                  onTextDelta: handlers.onTextDelta,
                  onFunctionCall: handlers.onFunctionCall,
                  onResponseDone: handlers.onResponseDone,
                  onClose: handlers.onClose,
                  onError: handlers.onError,
                }),
              openTts: (handlers) =>
                openElevenLabsTtsSession({
                  apiKey: elevenLabsApiKey,
                  voiceId: config.elevenLabsVoiceId ?? "",
                  ...(config.elevenLabsModelId === undefined ? {} : { modelId: config.elevenLabsModelId }),
                  ...(socketFactory === undefined ? {} : { socketFactory }),
                  ...(timers === undefined ? {} : { timers }),
                  ...(config.sessionLifetimeMs === undefined
                    ? {}
                    : { maxLifetimeMs: config.sessionLifetimeMs }),
                  onAudio: handlers.onAudio,
                  onContextDone: handlers.onContextDone,
                  onClose: handlers.onClose,
                  onError: handlers.onError,
                }),
            },
            timers === undefined ? {} : { timers },
          )
      : (open: VoiceConversationOpenInput) =>
          openRealtimeConversationSession({
            ...common,
            ...(config.realtimeProvider === "xai"
              ? {
                  provider: "xai" as const,
                  baseUrl: XAI_REALTIME_BASE_URL,
                  reasoningEffort: config.xaiReasoningEffort ?? "high",
                }
              : {}),
            model: config.realtimeModel,
            voice: config.voice,
            instructions: open.instructions,
            truncationRetentionRatio: config.truncationRetentionRatio,
            postInstructionsTokenLimit: config.postInstructionsTokenLimit,
            onAudioDelta: open.onAudioDelta,
            onFunctionCall: open.onFunctionCall,
            onResponseDone: open.onResponseDone,
            onClose: open.onClose,
            onError: open.onError,
          });
  return {
    openTranscription: (handlers: VoiceTranscriptionHandlers) =>
      config.realtimeProvider === "xai"
        ? openXaiStreamingTranscriptionSession({
            ...common,
            ...(config.language === undefined ? {} : { language: config.language }),
            onTranscript: handlers.onTranscript,
            onClose: handlers.onClose,
            onError: handlers.onError,
          })
        : openRealtimeTranscriptionSession({
            ...common,
            model: config.transcribeModel,
            ...(config.language === undefined ? {} : { language: config.language }),
            onTranscript: handlers.onTranscript,
            onClose: handlers.onClose,
            onError: handlers.onError,
          }),
    openConversation,
  };
}

export interface VoiceBriefingApiPort {
  fetchDiscordVoiceBriefing(
    input: DiscordVoiceBriefingRequest & { readonly schemaVersion: 1 },
  ): Promise<DiscordVoiceBriefing>;
}

export interface VoiceLookAtScreenApiPort {
  fetchPlayStill(): Promise<{
    readonly outcome: "not_playing" | "pending" | "still";
    readonly pngBase64?: string;
    readonly mimeType?: "image/png";
  }>;
}

export function createVoiceBriefingProvider(
  api: VoiceBriefingApiPort,
): (request: DiscordVoiceBriefingRequest) => Promise<DiscordVoiceBriefing> {
  return async (request) => {
    const briefing = await api.fetchDiscordVoiceBriefing({
      schemaVersion: 1,
      guildId: request.guildId,
      channelId: request.channelId,
      consentedUserIds: request.consentedUserIds,
    });
    return { instructions: briefing.instructions, briefing: briefing.briefing };
  };
}

export function createVoiceLookAtScreenProvider(
  api: VoiceLookAtScreenApiPort,
): () => Promise<LookAtScreenResult> {
  return async () => {
    const still = await api.fetchPlayStill();
    if (still.outcome === "still" && still.pngBase64 !== undefined) {
      return { outcome: "still", pngBase64: still.pngBase64, mimeType: "image/png" };
    }
    if (still.outcome === "pending") return { outcome: "pending" };
    return { outcome: "not_playing" };
  };
}

export interface VoiceIdleAutoLeaveOptions {
  readonly idleLeaveMs: number;
  readonly isActive: () => boolean;
  readonly leave: () => Promise<void>;
  readonly onLeave?: (idleMs: number) => void;
  readonly onLeaveError?: (error: unknown) => void;
  readonly timers?: RealtimeTimers;
}

const globalTimers: RealtimeTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class VoiceIdleAutoLeave {
  private readonly options: VoiceIdleAutoLeaveOptions;
  private readonly timers: RealtimeTimers;
  private handle: unknown;

  public constructor(options: VoiceIdleAutoLeaveOptions) {
    if (!Number.isSafeInteger(options.idleLeaveMs) || options.idleLeaveMs <= 0) {
      throw new Error("Voice idle auto-leave threshold must be a positive number of milliseconds");
    }
    this.options = options;
    this.timers = options.timers ?? globalTimers;
  }

  public observe(evidence: DiscordVoiceEvidence): void {
    switch (evidence.type) {
      case "joined":
      case "utterance":
      case "text_input":
      case "response":
      case "floor":
        this.arm();
        return;
      case "left":
        this.stop();
        return;
      default:
        return;
    }
  }

  public stop(): void {
    if (this.handle === undefined) return;
    this.timers.clearTimeout(this.handle);
    this.handle = undefined;
  }

  private arm(): void {
    this.stop();
    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined;
      if (!this.options.isActive()) return;
      this.options.onLeave?.(this.options.idleLeaveMs);
      void this.options.leave().catch((error: unknown) => this.options.onLeaveError?.(error));
    }, this.options.idleLeaveMs);
  }
}

export function voiceEvidenceReceiptType(evidence: DiscordVoiceEvidence): DiscordBridgeReceipt["type"] {
  return `discord.voice.${evidence.type}`;
}

export function voiceEvidenceReceiptData(evidence: DiscordVoiceEvidence): DiscordBridgeReceipt["data"] {
  const data: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      data[key] = value;
    }
  }
  return data;
}
