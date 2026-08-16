import type { DiscordVoiceEvidence } from "@clankie/protocol";
import type { DiscordBridgeReceipt } from "./receipt-store.ts";
import type { RealtimeTimers } from "./realtime-session.ts";
import { DEFAULT_DECAY_WINDOW_MS } from "./voice-floor.ts";
import type {
  DiscordVoiceBriefing,
  DiscordVoiceBriefingRequest,
  LookAtScreenResult,
} from "./voice-session.ts";

export const DEFAULT_VOICE_REALTIME_MODEL = "gpt-realtime-2.1";
export const DEFAULT_VOICE_TRANSCRIBE_MODEL = "gpt-realtime-whisper";
export const DEFAULT_VOICE_REALTIME_VOICE = "marin";
export const DEFAULT_VOICE_TRUNCATION_RETENTION = 0.7;
export const DEFAULT_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT = 12_000;
export const DEFAULT_VOICE_IDLE_LEAVE_MS = 15 * 60_000;
export const MAX_VOICE_IDLE_LEAVE_MS = 24 * 60 * 60_000;

export interface VoiceRealtimeBaseEnvConfig {
  readonly realtimeModel: string;
  readonly transcribeModel: string;
  readonly voice: string;
  readonly language?: string;
  readonly truncationRetentionRatio: number;
  readonly postInstructionsTokenLimit: number;
  readonly sessionLifetimeMs?: number;
  readonly decayWindowMs: number;
  readonly idleLeaveMs: number;
}

export function parseVoiceRealtimeBaseEnv(env: NodeJS.ProcessEnv): VoiceRealtimeBaseEnvConfig {
  const language = env.CLANKIE_VOICE_STT_LANGUAGE;
  const sessionLifetimeMs = optionalIntegerEnv(
    env,
    "CLANKIE_VOICE_SESSION_LIFETIME_MS",
    10_000,
    4 * 60 * 60_000,
  );
  return {
    realtimeModel: nonEmptyEnv(env, "CLANKIE_VOICE_REALTIME_MODEL", DEFAULT_VOICE_REALTIME_MODEL),
    transcribeModel: nonEmptyEnv(env, "CLANKIE_VOICE_TRANSCRIBE_MODEL", DEFAULT_VOICE_TRANSCRIBE_MODEL),
    voice: nonEmptyEnv(env, "CLANKIE_VOICE_REALTIME_VOICE", DEFAULT_VOICE_REALTIME_VOICE),
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
