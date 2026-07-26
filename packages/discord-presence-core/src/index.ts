/**
 * Transport-neutral Discord participation core (ADR 0024, ADR 0048).
 *
 * Everything here is deliberately blind to whether Clankie is wearing the
 * official bot or the personal-lab user session: ingress shaping, the presence
 * lifecycle, consent, capture, speech, and receipts are identical across both
 * planes. Only the two bridge apps know how to speak to Discord — which is what
 * lets one character, one Eve lane, and one memory projection span both bodies.
 *
 * Nothing in this package may import `discord.js`; a bot-shaped client is a
 * transport detail and belongs in the app that owns that transport.
 */
export {
  DiscordPresenceAdvertisedToolCatalog,
  DiscordPresencePublicationError,
  DiscordPresencePublicationTerminalError,
  DiscordPresenceSession,
  type DiscordPresencePublicationFailureDisposition,
  type DiscordPresenceSessionOptions,
} from "./presence-session.ts";
export {
  createAdvertisedDiscordPresencePort,
  DiscordPresenceActToolUnavailableError,
  type DiscordPresenceActionDeliveryPort,
} from "./presence-action-advertiser.ts";
export {
  DiscordTextIngress,
  addressesCharacter,
  CATCH_UP_INTERVAL_MS,
  parseDiscordDmPolicy,
  parseDiscordIdSet,
  parseDiscordReplyPolicy,
  type DiscordDmPolicy,
  type DiscordReplyPolicy,
  type DiscordInboundContextMessage,
  type DiscordInboundMessage,
  type DiscordTextIngressConfig,
  type DiscordTextIngressEvidence,
  type DiscordTextIngressOutcome,
  type DiscordTextIngressPort,
} from "./text-ingress.ts";
export {
  DiscordVoiceIngress,
  type DiscordVoiceCaptainPort,
  type DiscordVoiceIngressOptions,
  type DiscordVoiceTurn,
  type DiscordVoiceTurnOutcome,
} from "./voice-ingress.ts";
export {
  CAPTAIN_UNREACHABLE_TEXT,
  DiscordVoiceSession,
  ENGAGED_HOLD_MS,
  ENGAGED_TICK_MS,
  TRANSCRIPT_RING_MAX_BYTES,
  TRANSCRIPT_RING_MAX_LINES,
  type DiscordVoiceBriefing,
  type DiscordVoiceBriefingRequest,
  type DiscordVoiceRealtimePorts,
  type DiscordVoiceSessionOptions,
  type DiscordVoiceSessionStatus,
  type JoinDiscordVoiceInput,
  type VoiceConversationOpenInput,
  type VoiceConversationPort,
  type VoiceTranscriptionHandlers,
  type VoiceTranscriptionPort,
} from "./voice-session.ts";
export { DiscordVoiceConsentRegistry, type DiscordVoiceConsentSession } from "./voice-consent.ts";
export { addressKeys, phoneticKey, releasesFloor, voiceAddressesCharacter } from "./voice-address.ts";
export {
  DEFAULT_DECAY_WINDOW_MS,
  VOLITION_DEFAULTS,
  VoiceFloor,
  type FloorDecision,
  type FloorState,
  type VoiceFloorOptions,
  type VoiceTranscriptEvent,
  type VolitionAccounting,
  type VolitionRateCap,
} from "./voice-floor.ts";
export {
  ASK_CLANKIE_TOOL_NAME,
  DEFAULT_REALTIME_POST_INSTRUCTIONS_TOKEN_LIMIT,
  DEFAULT_REALTIME_SESSION_LIFETIME_MS,
  DEFAULT_REALTIME_TRUNCATION_RETENTION_RATIO,
  MAX_REALTIME_AUDIO_APPEND_BYTES,
  MAX_REALTIME_INSTRUCTIONS_CHARACTERS,
  MAX_REALTIME_RESPONSE_AUDIO_BYTES,
  MAX_REALTIME_TEXT_ITEM_CHARACTERS,
  openRealtimeConversationSession,
  openRealtimeTranscriptionSession,
  openRealtimeWebSocket,
  REALTIME_AUDIO_SAMPLE_RATE,
  RealtimeConversationSession,
  RealtimeTranscriptionSession,
  type RealtimeConversationSessionOptions,
  type RealtimeFunctionCall,
  type RealtimeResponseMeta,
  type RealtimeSessionCloseReason,
  type RealtimeSocket,
  type RealtimeSocketFactory,
  type RealtimeTimers,
  type RealtimeTranscriptEvent,
  type RealtimeTranscriptionSessionOptions,
} from "./realtime-session.ts";
export {
  discordPcmToRealtimePcm,
  discordPcmToSpeechPcm,
  encodeMonoPcmWav,
  openAiPcmToDiscordPcm,
  pcmDurationMs,
  SPEECH_SAMPLE_RATE,
} from "./voice-audio.ts";
export {
  DiscordBridgeReceiptSchema,
  DiscordBridgeReceiptStore,
  parseDiscordBridgeReceipt,
  type DiscordBridgeReceipt,
  type DiscordBridgeReceiptStoreOptions,
} from "./receipt-store.ts";
