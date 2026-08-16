/**
 * Bridge-side composition for the two-tier realtime voice architecture
 * ([ADR 0057](../../../docs/adr/0057-realtime-voice-with-captain-handoff.md)).
 *
 * Everything here is deliberately import-light and side-effect free so the
 * bot-specific environment parsing, realtime ports, and user-facing disclosure
 * text are testable offline without touching the process-global startup in
 * `index.ts`. Transport-neutral helpers are re-exported from the shared core.
 */

import {
  openElevenLabsTtsSession,
  openExternalVoiceConversation,
  openRealtimeConversationSession,
  openRealtimeTranscriptionSession,
  type DiscordVoiceRealtimePorts,
  type DiscordVoiceConsentPolicy,
  type DiscordVoiceSessionStatus,
  parseVoiceRealtimeBaseEnv,
  type RealtimeSocketFactory,
  type RealtimeTimers,
  type VoiceRealtimeBaseEnvConfig,
  type VoiceConversationOpenInput,
  type VoiceTranscriptionHandlers,
} from "@clankie/discord-presence-core";
import type { DiscordVoiceEvidence } from "@clankie/protocol";

export {
  DEFAULT_VOICE_IDLE_LEAVE_MS,
  DEFAULT_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT,
  DEFAULT_VOICE_REALTIME_MODEL,
  DEFAULT_VOICE_REALTIME_VOICE,
  DEFAULT_VOICE_TRANSCRIBE_MODEL,
  DEFAULT_VOICE_TRUNCATION_RETENTION,
  MAX_VOICE_IDLE_LEAVE_MS,
  VoiceIdleAutoLeave,
  createVoiceBriefingProvider,
  createVoiceLookAtScreenProvider,
  voiceEvidenceReceiptData,
  voiceEvidenceReceiptType,
} from "@clankie/discord-presence-core";

// ---------------------------------------------------------------------------
// Environment configuration.
// ---------------------------------------------------------------------------

/**
 * Who synthesizes his speech ([ADR 0070](../../../docs/adr/0070-external-voice-via-streaming-tts.md)):
 * `openai` is the realtime model's own mouth, `elevenlabs` switches the
 * engaged session to text output streamed through ElevenLabs TTS.
 */
export const VOICE_TTS_PROVIDERS = ["openai", "elevenlabs"] as const;
export type VoiceTtsProvider = (typeof VOICE_TTS_PROVIDERS)[number];
export const DEFAULT_VOICE_TTS_PROVIDER: VoiceTtsProvider = "openai";

/** Removed knobs and where their job went. Set-but-ignored configuration is drift, so they fail loudly. */
const RETIRED_VOICE_ENV: Readonly<Record<string, string>> = {
  CLANKIE_VOICE_STT_MODEL: "use CLANKIE_VOICE_TRANSCRIBE_MODEL",
  CLANKIE_VOICE_TTS_MODEL: "use CLANKIE_VOICE_REALTIME_MODEL",
  CLANKIE_VOICE_TTS_VOICE: "use CLANKIE_VOICE_REALTIME_VOICE",
  CLANKIE_VOICE_VOLITION_MODEL:
    "there is no separate volition model — his own realtime session decides whether to speak up",
};

export interface VoiceRealtimeEnvConfig extends VoiceRealtimeBaseEnvConfig {
  readonly ttsProvider: VoiceTtsProvider;
  /** Required exactly when {@link ttsProvider} is `elevenlabs`. */
  readonly elevenLabsVoiceId?: string;
  readonly elevenLabsModelId?: string;
}

/**
 * Parses and validates the realtime voice environment. Throws on invalid or
 * retired values — silent configuration provenance is exactly what wastes an
 * hour of debugging.
 */
export function parseVoiceRealtimeEnv(env: NodeJS.ProcessEnv): VoiceRealtimeEnvConfig {
  const retired = Object.entries(RETIRED_VOICE_ENV).filter(([name]) => env[name] !== undefined);
  if (retired.length > 0) {
    throw new Error(
      `Retired voice configuration is set and would be ignored: ${retired
        .map(([name, guidance]) => `${name} (${guidance})`)
        .join(", ")}.`,
    );
  }
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
    ...parseVoiceRealtimeBaseEnv(env),
    ttsProvider,
    ...(ttsProvider === "elevenlabs" && elevenLabsVoiceId !== undefined ? { elevenLabsVoiceId } : {}),
    ...(ttsProvider === "elevenlabs" && elevenLabsModelId !== undefined && elevenLabsModelId.length > 0
      ? { elevenLabsModelId }
      : {}),
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

// ---------------------------------------------------------------------------
// Realtime ports.
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

// ---------------------------------------------------------------------------
// Evidence → receipts and the operator-visible response line.
// ---------------------------------------------------------------------------

export type DiscordVoiceResponseEvidence = Extract<DiscordVoiceEvidence, { type: "response" }>;

/**
 * The per-turn latency line. "It felt slow" is only actionable next to the
 * stage split, and ADR 0057 requires waking and continuing turns to be
 * separately visible or the wake cost is invisible.
 */
export function describeVoiceResponse(evidence: DiscordVoiceResponseEvidence): string {
  const path = evidence.fastPath
    ? "fast path"
    : `clankie handoff ${String(Math.round(evidence.handoffMs))}ms`;
  // Both fast-path triggers report a zero handoff, so without naming the
  // trigger a play narration and a real reply to the room are the same line.
  const trigger = evidence.trigger === "narration" ? "narration" : "room";
  return (
    `voice turn (${evidence.wake}, ${trigger}, ${path}): ` +
    `${String(Math.round(evidence.toFirstAudioMs))}ms ` +
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
  consentPolicy: DiscordVoiceConsentPolicy = "explicit",
): string {
  if (consentPolicy === "presence") {
    return (
      `Joined with DAVE protocol ${String(daveProtocolVersion)}. Anyone in this voice channel can talk to me — ` +
      `being here is consent. **/clankie voice-consent opt-out** refuses for the rest of this call. ` +
      `Room audio feeds a live OpenAI realtime session that keeps this call's conversation ` +
      `on OpenAI's servers for as long as the call lasts. I listen continuously but speak only ` +
      `when addressed, or briefly on my own initiative. ${describeSpokenReplies(ttsProvider)} ` +
      `Nothing said in voice can ever approve privileged actions.`
    );
  }
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
  consentPolicy: DiscordVoiceConsentPolicy = "explicit",
): string {
  if (!consented) {
    return "Your voice consent is revoked and any active capture for you was discarded.";
  }
  if (consentPolicy === "presence") {
    return (
      `This server already treats being in the call as consent — you do not need to opt in each session. ` +
      `Anyone in this voice channel can talk. **/clankie voice-consent opt-out** refuses for the rest of this call. ` +
      `Room audio feeds a live OpenAI realtime session that keeps this call's conversation ` +
      `on OpenAI's servers for as long as the call lasts. ${describeSpokenReplies(ttsProvider)} ` +
      `Nothing said in voice can ever approve privileged actions.`
    );
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
  consentPolicy: DiscordVoiceConsentPolicy = "explicit",
): string {
  if (status?.active !== true) {
    return `Voice is ${voiceEnabled ? "enabled but not connected" : "disabled"}.`;
  }
  const posture = status.floorState === "engaged" ? "engaged in conversation" : "listening dormant";
  const who =
    consentPolicy === "presence"
      ? "anyone in this channel can talk (opt-out still binds)"
      : `${String(status.consentedParticipantCount)} participant(s) opted in`;
  return (
    `Voice is active with DAVE protocol ${String(status.daveProtocolVersion)}; ` +
    `${who}, ` +
    `${String(status.activeCaptureCount)} bounded capture(s) active, currently ${posture}. ` +
    `I hold a short bounded transcript window in memory, and the live OpenAI realtime session ` +
    `keeps this call's conversation server-side for the duration of the call.`
  );
}
