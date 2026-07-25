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
  parseDiscordDmPolicy,
  parseDiscordIdSet,
  type DiscordDmPolicy,
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
  DiscordVoiceSession,
  type DiscordVoiceEvidence,
  type DiscordVoiceSessionOptions,
  type DiscordVoiceSessionStatus,
  type JoinDiscordVoiceInput,
} from "./voice-session.ts";
export { DiscordVoiceConsentRegistry, type DiscordVoiceConsentSession } from "./voice-consent.ts";
export {
  discordPcmToSpeechPcm,
  encodeMonoPcmWav,
  openAiPcmToDiscordPcm,
  pcmDurationMs,
  SPEECH_SAMPLE_RATE,
} from "./voice-audio.ts";
export {
  OpenAiVoiceSpeechRuntime,
  type OpenAiVoiceSpeechRuntimeOptions,
  type SynthesizedVoiceAudio,
  type VoiceSpeechReadiness,
  type VoiceSpeechRuntime,
} from "./voice-speech.ts";
export {
  DiscordBridgeReceiptSchema,
  DiscordBridgeReceiptStore,
  parseDiscordBridgeReceipt,
  type DiscordBridgeReceipt,
  type DiscordBridgeReceiptStoreOptions,
} from "./receipt-store.ts";
