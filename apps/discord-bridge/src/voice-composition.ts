/**
 * Bridge-side composition for the two-tier realtime voice architecture
 * ([ADR 0057](../../../docs/adr/0057-realtime-voice-with-captain-handoff.md)).
 *
 * Everything here is deliberately import-light and side-effect free so the
 * wiring the bridge actually runs — environment parsing, the realtime ports,
 * the briefing provider, the volition decider, the idle auto-leave, and the
 * user-facing disclosure text — is testable offline without touching the
 * process-global startup in `index.ts`.
 */

import type {
  DiscordVoiceBriefing as ApiDiscordVoiceBriefing,
  DiscordVoiceBriefingRequest as ApiDiscordVoiceBriefingRequest,
} from "@clankie/api-client";
import {
  DEFAULT_DECAY_WINDOW_MS,
  openElevenLabsTtsSession,
  openExternalVoiceConversation,
  openRealtimeConversationSession,
  openRealtimeTranscriptionSession,
  type DiscordBridgeReceipt,
  type DiscordVoiceBriefing,
  type DiscordVoiceBriefingRequest,
  type DiscordVoiceRealtimePorts,
  type DiscordVoiceSessionStatus,
  type RealtimeSocketFactory,
  type RealtimeTimers,
  type VoiceConversationOpenInput,
  type VoiceTranscriptionHandlers,
} from "@clankie/discord-presence-core";
import type { DiscordVoiceEvidence } from "@clankie/protocol";

// ---------------------------------------------------------------------------
// Environment configuration.
// ---------------------------------------------------------------------------

/** The engaged conversation tier (ADR 0057's decision of record). */
export const DEFAULT_VOICE_REALTIME_MODEL = "gpt-realtime-2.1";
/** The dormant listener tier. */
export const DEFAULT_VOICE_TRANSCRIBE_MODEL = "gpt-realtime-whisper";
/** The voice the cascade already used, so the architecture swap does not change how he sounds. */
export const DEFAULT_VOICE_REALTIME_VOICE = "marin";
/**
 * Who synthesizes his speech ([ADR 0070](../../../docs/adr/0070-external-voice-via-streaming-tts.md)):
 * `openai` is the realtime model's own mouth, `elevenlabs` switches the
 * engaged session to text output streamed through ElevenLabs TTS.
 */
export const VOICE_TTS_PROVIDERS = ["openai", "elevenlabs"] as const;
export type VoiceTtsProvider = (typeof VOICE_TTS_PROVIDERS)[number];
export const DEFAULT_VOICE_TTS_PROVIDER: VoiceTtsProvider = "openai";
/** `session.truncation` retention ratio — configured, never defaulted to unbounded (mission T6). */
export const DEFAULT_VOICE_TRUNCATION_RETENTION = 0.7;
export const DEFAULT_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT = 12_000;
/**
 * A joined channel is metered (ADR 0057 cost consequence), so an idle call must
 * end itself. Fifteen minutes of no utterance, response, or floor movement
 * means the room moved on without him.
 */
export const DEFAULT_VOICE_IDLE_LEAVE_MS = 15 * 60_000;
/** The idle timer must stay bounded: a day-long "idle" cap is a disabled cap. */
export const MAX_VOICE_IDLE_LEAVE_MS = 24 * 60 * 60_000;
/** The volition gate's one cheap text call (ADR 0057); never a realtime session. */
export const DEFAULT_VOICE_VOLITION_MODEL = "gpt-4o-mini";

/** Cascade-era knobs. Set-but-ignored configuration is drift, so they fail loudly. */
const RETIRED_VOICE_ENV_NAMES = [
  "CLANKIE_VOICE_STT_MODEL",
  "CLANKIE_VOICE_TTS_MODEL",
  "CLANKIE_VOICE_TTS_VOICE",
] as const;

export interface VoiceRealtimeEnvConfig {
  readonly realtimeModel: string;
  readonly transcribeModel: string;
  readonly voice: string;
  readonly ttsProvider: VoiceTtsProvider;
  /** Required exactly when {@link ttsProvider} is `elevenlabs`. */
  readonly elevenLabsVoiceId?: string;
  readonly elevenLabsModelId?: string;
  /**
   * `CLANKIE_VOICE_STT_LANGUAGE`, unchanged semantics from the cascade: unset
   * defers to the runtime's pinned default, empty restores per-utterance
   * auto-detection for a genuinely multilingual room.
   */
  readonly language?: string;
  readonly truncationRetentionRatio: number;
  readonly postInstructionsTokenLimit: number;
  /** Optional override of the runtime's session lifetime cap. */
  readonly sessionLifetimeMs?: number;
  /** Owner-tunable floor decay dial (mission human decision 1). */
  readonly decayWindowMs: number;
  readonly idleLeaveMs: number;
  readonly volitionModel: string;
}

/**
 * Parses and validates the realtime voice environment. Throws on invalid or
 * retired values — silent configuration provenance is exactly what wastes an
 * hour of debugging.
 */
export function parseVoiceRealtimeEnv(env: NodeJS.ProcessEnv): VoiceRealtimeEnvConfig {
  const retired = RETIRED_VOICE_ENV_NAMES.filter((name) => env[name] !== undefined);
  if (retired.length > 0) {
    throw new Error(
      `${retired.join(", ")} belong to the removed STT→captain→TTS cascade. Use ` +
        "CLANKIE_VOICE_TRANSCRIBE_MODEL, CLANKIE_VOICE_REALTIME_MODEL, and CLANKIE_VOICE_REALTIME_VOICE.",
    );
  }
  const language = env.CLANKIE_VOICE_STT_LANGUAGE;
  const sessionLifetimeMs = optionalIntegerEnv(
    env,
    "CLANKIE_VOICE_SESSION_LIFETIME_MS",
    10_000,
    4 * 60 * 60_000,
  );
  const ttsProvider = ttsProviderEnv(env);
  const elevenLabsVoiceId = env.CLANKIE_VOICE_ELEVENLABS_VOICE_ID?.trim();
  const elevenLabsModelId = env.CLANKIE_VOICE_ELEVENLABS_MODEL_ID?.trim();
  if (ttsProvider === "elevenlabs") {
    if (elevenLabsVoiceId === undefined || elevenLabsVoiceId.length === 0) {
      throw new Error(
        "CLANKIE_VOICE_ELEVENLABS_VOICE_ID is required when CLANKIE_VOICE_TTS_PROVIDER=elevenlabs",
      );
    }
  } else if (elevenLabsVoiceId !== undefined || elevenLabsModelId !== undefined) {
    // Set-but-ignored configuration is drift, the same rule the retired
    // cascade names enforce above.
    throw new Error(
      "CLANKIE_VOICE_ELEVENLABS_VOICE_ID and CLANKIE_VOICE_ELEVENLABS_MODEL_ID require " +
        "CLANKIE_VOICE_TTS_PROVIDER=elevenlabs",
    );
  }
  return {
    realtimeModel: nonEmptyEnv(env, "CLANKIE_VOICE_REALTIME_MODEL", DEFAULT_VOICE_REALTIME_MODEL),
    transcribeModel: nonEmptyEnv(env, "CLANKIE_VOICE_TRANSCRIBE_MODEL", DEFAULT_VOICE_TRANSCRIBE_MODEL),
    voice: nonEmptyEnv(env, "CLANKIE_VOICE_REALTIME_VOICE", DEFAULT_VOICE_REALTIME_VOICE),
    ttsProvider,
    ...(ttsProvider === "elevenlabs" && elevenLabsVoiceId !== undefined ? { elevenLabsVoiceId } : {}),
    ...(ttsProvider === "elevenlabs" && elevenLabsModelId !== undefined && elevenLabsModelId.length > 0
      ? { elevenLabsModelId }
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
    volitionModel: nonEmptyEnv(env, "CLANKIE_VOICE_VOLITION_MODEL", DEFAULT_VOICE_VOLITION_MODEL),
  };
}

function ttsProviderEnv(env: NodeJS.ProcessEnv): VoiceTtsProvider {
  const value = env.CLANKIE_VOICE_TTS_PROVIDER;
  if (value === undefined) return DEFAULT_VOICE_TTS_PROVIDER;
  const normalized = value.trim().toLowerCase();
  const match = VOICE_TTS_PROVIDERS.find((provider) => provider === normalized);
  if (match === undefined) {
    throw new Error(`CLANKIE_VOICE_TTS_PROVIDER must be one of: ${VOICE_TTS_PROVIDERS.join(", ")}`);
  }
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

// ---------------------------------------------------------------------------
// Realtime ports and the briefing provider.
// ---------------------------------------------------------------------------

export interface VoiceRealtimePortsInput {
  /** Broker-resolved OpenAI key — never `OPENAI_API_KEY` from the environment. */
  readonly apiKey: string;
  /**
   * Broker-resolved ElevenLabs key under provider id `elevenlabs` — never an
   * environment variable. Required exactly when the config's TTS provider is
   * `elevenlabs`.
   */
  readonly elevenLabsApiKey?: string;
  readonly config: VoiceRealtimeEnvConfig;
  /** Injected by tests; production defaults to the runtime's WebSocket factory. */
  readonly socketFactory?: RealtimeSocketFactory;
  readonly timers?: RealtimeTimers;
}

/**
 * Implements {@link DiscordVoiceRealtimePorts} by delegating to the T2
 * runtimes. Truncation is always passed explicitly: ADR 0057 makes it
 * required, not optional, because context re-billing is the cost term that
 * actually grows.
 */
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
          // ADR 0070: the engaged tier becomes a pair — text-modality
          // realtime ears and an ElevenLabs mouth — behind the same port.
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
                  // Presence of the voice id is enforced by parseVoiceRealtimeEnv.
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
      openRealtimeTranscriptionSession({
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
  fetchDiscordVoiceBriefing(input: ApiDiscordVoiceBriefingRequest): Promise<ApiDiscordVoiceBriefing>;
}

/**
 * Maps the media owner's briefing request onto the control plane's endpoint.
 * The request carries only ids; persona, lane instructions, self-state, and
 * approved person memory are all control-plane-resolved (T4), so the bridge
 * can neither supply nor widen any of them.
 */
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

// ---------------------------------------------------------------------------
// The volition decider: one cheap gated text call, fails closed.
// ---------------------------------------------------------------------------

export const VOICE_VOLITION_SYSTEM_PROMPT =
  "You decide whether Clankie, a participant in a Discord voice room, has something genuinely " +
  "worth saying right now. Answer strictly yes or no.";
const VERDICT_TIMEOUT_MS = 10_000;
/** Matches the transcript ring bound; anything longer is a leak, not a room. */
const VOLITION_ROOM_TEXT_MAX_CHARACTERS = 4_000;
/** A one-word verdict has no business arriving in a payload bigger than this. */
const VERDICT_RESPONSE_MAX_CHARACTERS = 65_536;

export interface BoundedChatVerdictInput {
  /** The same brokered OpenAI key the realtime ports use. */
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt: string;
  /** Untrusted user text is sliced to this bound before it is sent. */
  readonly maxUserTextCharacters: number;
  /** Must be HTTPS unless loopback. Defaults to the OpenAI API origin. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * One bounded chat verdict: temperature 0, a handful of output tokens, a hard
 * timeout, and a bounded response. Returns the normalized verdict token
 * (trimmed, lowercased, trailing punctuation stripped) or `undefined` on any
 * failure — timeouts, transport errors, bad statuses, malformed or over-long
 * payloads. It never throws and never logs the user text: a transport error
 * object can echo the request, and untrusted text must never reach logs.
 */
export function createBoundedChatVerdict(
  input: BoundedChatVerdictInput,
): (userText: string) => Promise<string | undefined> {
  const url = new URL("/v1/chat/completions", input.baseUrl ?? "https://api.openai.com");
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Bounded verdict base URL must use HTTPS unless it is loopback");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? VERDICT_TIMEOUT_MS;
  return async (userText) => {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify({
          model: input.model,
          temperature: 0,
          max_tokens: 5,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: userText.slice(0, input.maxUserTextCharacters) },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return undefined;
      const raw = await response.text();
      if (raw.length > VERDICT_RESPONSE_MAX_CHARACTERS) return undefined;
      const verdict = extractChatContent(JSON.parse(raw));
      if (verdict === undefined) return undefined;
      return verdict
        .trim()
        .toLowerCase()
        .replace(/[.,;:!]+$/u, "");
    } catch {
      // Fail closed; deliberately unlogged (see above).
      return undefined;
    }
  };
}

export interface VoiceVolitionDeciderInput {
  /** The same brokered OpenAI key the realtime ports use. */
  readonly apiKey: string;
  readonly model: string;
  /** Must be HTTPS unless loopback. Defaults to the OpenAI API origin. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * ADR 0057's volition call. The gate is cheap and mechanical (the floor
 * machine rate-caps it); this decides only content. It never throws, never
 * logs room text, and anything other than a clear "yes" — including timeouts,
 * transport errors, and over-long responses — is a suppressed offer.
 */
export function createVoiceVolitionDecider(
  input: VoiceVolitionDeciderInput,
): (roomText: string) => Promise<boolean> {
  const verdict = createBoundedChatVerdict({
    apiKey: input.apiKey,
    model: input.model,
    systemPrompt: VOICE_VOLITION_SYSTEM_PROMPT,
    maxUserTextCharacters: VOLITION_ROOM_TEXT_MAX_CHARACTERS,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  return async (roomText) => (await verdict(roomText)) === "yes";
}

function extractChatContent(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const choices = (parsed as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first: unknown = choices[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) return undefined;
  const message = (first as Record<string, unknown>).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

// ---------------------------------------------------------------------------
// Idle auto-leave: a joined channel is metered, so idleness ends it.
// ---------------------------------------------------------------------------

export interface VoiceIdleAutoLeaveOptions {
  readonly idleLeaveMs: number;
  readonly isActive: () => boolean;
  readonly leave: () => Promise<void>;
  /** Log seam — called just before leaving, with the idle threshold that fired. */
  readonly onLeave?: (idleMs: number) => void;
  readonly onLeaveError?: (error: unknown) => void;
  readonly timers?: RealtimeTimers;
}

const globalTimers: RealtimeTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Watches the voice evidence stream and leaves the channel after
 * `CLANKIE_VOICE_IDLE_LEAVE_MS` with no conversational sign of life. Joining
 * arms the timer; utterances, responses, and floor movement re-arm it; leaving
 * (his own or the auto-leave's) disarms it.
 */
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
      // Consent changes, overlaps, interruptions, volition accounting, and
      // failures are not conversational activity; they neither arm nor feed
      // the idle clock.
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
      void this.options.leave().catch((error: unknown) => {
        this.options.onLeaveError?.(error);
      });
    }, this.options.idleLeaveMs);
  }
}

// ---------------------------------------------------------------------------
// Evidence → receipts and the operator-visible response line.
// ---------------------------------------------------------------------------

/** Every ADR 0057 evidence type maps 1:1 onto the receipt vocabulary. */
export function voiceEvidenceReceiptType(evidence: DiscordVoiceEvidence): DiscordBridgeReceipt["type"] {
  return `discord.voice.${evidence.type}`;
}

/**
 * Projects evidence into the receipt store's flat scalar record. Evidence is
 * content-free by protocol construction; this only flattens it, dropping
 * absent optional fields (the store's record type admits no `undefined`).
 */
export function voiceEvidenceReceiptData(evidence: DiscordVoiceEvidence): DiscordBridgeReceipt["data"] {
  const data: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      data[key] = value;
    }
  }
  return data;
}

export type DiscordVoiceResponseEvidence = Extract<DiscordVoiceEvidence, { type: "response" }>;

/**
 * The per-turn latency line. "It felt slow" is only actionable next to the
 * stage split, and ADR 0057 requires waking and continuing turns to be
 * separately visible or the wake cost is invisible.
 */
export function describeVoiceResponse(evidence: DiscordVoiceResponseEvidence): string {
  const path = evidence.fastPath
    ? "fast path"
    : `captain handoff ${String(Math.round(evidence.handoffMs))}ms`;
  return (
    `voice turn (${evidence.wake}, ${path}): ${String(Math.round(evidence.toFirstAudioMs))}ms ` +
    `to first audio, then ${String(Math.round(evidence.playbackMs))}ms speaking`
  );
}

// ---------------------------------------------------------------------------
// Disclosure text.
//
// Delivery is ephemeral-only, by owner decision: Clankie never posts into the
// text channel on join, because a member announcing terms of service at the
// door is a bot behavior, and his public presence should be the same one a
// person has — sitting visibly in the voice channel. The disclosure instead
// reaches exactly the people it binds, at the moment it binds them: the
// invoker in their private join reply, and every other participant in their
// private opt-in reply. Nobody it does not apply to ever sees it, and the
// consent model loses nothing — unconsented participants are never streamed,
// so there is nothing to disclose to them.
// ---------------------------------------------------------------------------

/**
 * The `/clankie join` disclosure, shown ephemerally to the invoker (who is
 * auto-opted-in). ADR 0057's most significant user-visible change: audio now
 * joins a live realtime session that retains the conversation server-side for
 * the life of the call, so this text must state live-session residency and
 * must never promise per-turn discard.
 */
export function renderVoiceJoinDisclosure(
  daveProtocolVersion: number | undefined,
  ttsProvider: VoiceTtsProvider = DEFAULT_VOICE_TTS_PROVIDER,
): string {
  return (
    `Joined with DAVE protocol ${String(daveProtocolVersion)}. Only you are opted in — ` +
    `audio from anyone who has not explicitly consented is never streamed anywhere. ` +
    `Consented audio feeds a live OpenAI realtime session that keeps this call's conversation ` +
    `on OpenAI's servers for as long as the call lasts. I listen continuously but speak only ` +
    `when addressed, or briefly on my own initiative. ${describeSpokenReplies(ttsProvider)} ` +
    `Nothing said in voice can ever approve privileged actions. ` +
    `Use **/clankie voice-consent opt-in** to let me hear you and ` +
    `**/clankie voice-consent opt-out** to revoke immediately.`
  );
}

/**
 * The synthesized-speech sentence (ADR 0070). Under an external voice the
 * words Clankie chooses transit a second vendor, and the disclosure must say
 * so — while staying equally clear that room audio never does.
 */
function describeSpokenReplies(ttsProvider: VoiceTtsProvider): string {
  if (ttsProvider === "elevenlabs") {
    return (
      "My spoken replies use an AI-generated voice synthesized by ElevenLabs from the words I " +
      "choose; your audio is never sent to ElevenLabs."
    );
  }
  return "My spoken replies use an AI-generated voice.";
}

/**
 * The `/clankie voice-consent` reply, shown ephemerally to the participant.
 *
 * Opt-in is where a non-invoking participant actually grants consent, and the
 * join disclosure was never shown to them — so the residency terms travel in
 * this reply, before anything of theirs is streamed on the next utterance.
 */
export function renderVoiceConsentReply(
  consented: boolean,
  participantCount: number,
  ttsProvider: VoiceTtsProvider = DEFAULT_VOICE_TTS_PROVIDER,
): string {
  if (!consented) {
    return "Your voice consent is revoked and any active capture for you was discarded.";
  }
  return (
    `You are opted in for this voice session. ${String(participantCount)} participant(s) are now opted in. ` +
    `Your consented audio feeds a live OpenAI realtime session that keeps this call's conversation ` +
    `on OpenAI's servers for as long as the call lasts. ${describeSpokenReplies(ttsProvider)} ` +
    `Nothing said in voice can ever approve privileged actions. ` +
    `**/clankie voice-consent opt-out** revokes immediately.`
  );
}

/** The `/clankie voice-status` reply, truthful under live-session residency. */
export function renderVoiceStatusReply(
  status: DiscordVoiceSessionStatus | undefined,
  voiceEnabled: boolean,
): string {
  if (status?.active !== true) {
    return `Voice is ${voiceEnabled ? "enabled but not connected" : "disabled"}.`;
  }
  const posture = status.floorState === "engaged" ? "engaged in conversation" : "listening dormant";
  return (
    `Voice is active with DAVE protocol ${String(status.daveProtocolVersion)}; ` +
    `${String(status.consentedParticipantCount)} participant(s) opted in, ` +
    `${String(status.activeCaptureCount)} bounded capture(s) active, currently ${posture}. ` +
    `I hold a short bounded transcript window in memory, and the live OpenAI realtime session ` +
    `keeps this call's conversation server-side for the duration of the call.`
  );
}
