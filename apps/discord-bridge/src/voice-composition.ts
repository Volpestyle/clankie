/**
 * Bridge-side voice presentation. Provider/runtime composition lives in the
 * shared presence core so the bot and user-session bodies cannot drift.
 */

import {
  DEFAULT_VOICE_REALTIME_PROVIDER,
  DEFAULT_VOICE_TTS_PROVIDER,
  type DiscordVoiceConsentPolicy,
  type DiscordVoiceSessionStatus,
  type VoiceRealtimeProvider,
  type VoiceTtsProvider,
} from "@clankie/discord-presence-core";
import type { DiscordVoiceEvidence } from "@clankie/protocol";

export function describeVoiceResponse(evidence: Extract<DiscordVoiceEvidence, { type: "response" }>): string {
  const path = evidence.fastPath
    ? "fast path"
    : `clankie handoff ${String(Math.round(evidence.handoffMs))}ms`;
  const trigger = evidence.trigger === "narration" ? "narration" : "room";
  return (
    `voice turn (${evidence.wake}, ${trigger}, ${path}): ` +
    `${String(Math.round(evidence.toFirstAudioMs))}ms ` +
    `to first audio, then ${String(Math.round(evidence.playbackMs))}ms speaking`
  );
}

export function renderVoiceJoinDisclosure(
  daveProtocolVersion: number | undefined,
  ttsProvider: VoiceTtsProvider = DEFAULT_VOICE_TTS_PROVIDER,
  consentPolicy: DiscordVoiceConsentPolicy = "explicit",
  realtimeProvider: VoiceRealtimeProvider = DEFAULT_VOICE_REALTIME_PROVIDER,
  transcriptLoggingEnabled = false,
): string {
  const processing = describeVoiceProcessing(realtimeProvider);
  const retention = describeLocalTranscriptRetention(transcriptLoggingEnabled);
  if (consentPolicy === "presence") {
    return (
      `Joined with DAVE protocol ${String(daveProtocolVersion)}. Anyone in this voice channel can talk to me — ` +
      `being here is consent. **/clankie voice-consent opt-out** refuses for the rest of this call. ` +
      `${processing}${retention} I listen continuously but speak only when addressed, or briefly on my own initiative. ` +
      `${describeSpokenReplies(ttsProvider)} Nothing said in voice can ever approve privileged actions.`
    );
  }
  return (
    `Joined with DAVE protocol ${String(daveProtocolVersion)}. Only you are opted in — ` +
    `audio from anyone who has not explicitly consented is never streamed anywhere. ` +
    `${processing}${retention} I listen continuously but speak only when addressed, or briefly on my own initiative. ` +
    `${describeSpokenReplies(ttsProvider)} Nothing said in voice can ever approve privileged actions. ` +
    `Use **/clankie voice-consent opt-in** to let me hear you and ` +
    `**/clankie voice-consent opt-out** to revoke immediately.`
  );
}

function describeLocalTranscriptRetention(enabled: boolean): string {
  return enabled
    ? " Exact consented speech and speaker attribution are retained in a private local development transcript log."
    : "";
}

function describeVoiceProcessing(provider: VoiceRealtimeProvider): string {
  return provider === "xai"
    ? "Consented audio is processed by live xAI Voice sessions for this call; xAI states that audio is processed in real time and is not stored."
    : "Consented audio feeds a live OpenAI realtime session that keeps this call's conversation on OpenAI's servers for as long as the call lasts.";
}

function describeSpokenReplies(ttsProvider: VoiceTtsProvider): string {
  if (ttsProvider === "elevenlabs") {
    return (
      "My spoken replies use an AI-generated voice synthesized by ElevenLabs from the words I " +
      "choose; your audio is never sent to ElevenLabs."
    );
  }
  return "My spoken replies use an AI-generated voice.";
}

export function renderVoiceConsentReply(
  consented: boolean,
  participantCount: number,
  ttsProvider: VoiceTtsProvider = DEFAULT_VOICE_TTS_PROVIDER,
  consentPolicy: DiscordVoiceConsentPolicy = "explicit",
  realtimeProvider: VoiceRealtimeProvider = DEFAULT_VOICE_REALTIME_PROVIDER,
  transcriptLoggingEnabled = false,
): string {
  if (!consented) {
    return "Your voice consent is revoked and any active capture for you was discarded.";
  }
  const processing = describeVoiceProcessing(realtimeProvider);
  const retention = describeLocalTranscriptRetention(transcriptLoggingEnabled);
  if (consentPolicy === "presence") {
    return (
      `This server already treats being in the call as consent — you do not need to opt in each session. ` +
      `Anyone in this voice channel can talk. **/clankie voice-consent opt-out** refuses for the rest of this call. ` +
      `${processing}${retention} ${describeSpokenReplies(ttsProvider)} ` +
      `Nothing said in voice can ever approve privileged actions.`
    );
  }
  return (
    `You are opted in for this voice session. ${String(participantCount)} participant(s) are now opted in. ` +
    `${processing}${retention} ${describeSpokenReplies(ttsProvider)} ` +
    `Nothing said in voice can ever approve privileged actions. ` +
    `**/clankie voice-consent opt-out** revokes immediately.`
  );
}

export function renderVoiceStatusReply(
  status: DiscordVoiceSessionStatus | undefined,
  voiceEnabled: boolean,
  consentPolicy: DiscordVoiceConsentPolicy = "explicit",
  realtimeProvider: VoiceRealtimeProvider = DEFAULT_VOICE_REALTIME_PROVIDER,
  transcriptLoggingEnabled = false,
): string {
  if (status?.active !== true) {
    return (
      `Voice is ${voiceEnabled ? "enabled but not connected" : "disabled"}.` +
      (transcriptLoggingEnabled ? " Full local transcript logging is enabled." : "")
    );
  }
  const posture = status.floorState === "engaged" ? "engaged in conversation" : "listening dormant";
  const who =
    consentPolicy === "presence"
      ? "anyone in this channel can talk (opt-out still binds)"
      : `${String(status.consentedParticipantCount)} participant(s) opted in`;
  const provider = realtimeProvider === "xai" ? "xAI Voice" : "OpenAI realtime";
  return (
    `Voice is active with DAVE protocol ${String(status.daveProtocolVersion)}; ` +
    `${who}, ${String(status.activeCaptureCount)} bounded capture(s) active, currently ${posture}. ` +
    (transcriptLoggingEnabled
      ? "A private local development log retains exact consented speech and speaker attribution. "
      : "") +
    `I hold a short bounded transcript window in memory, and the live ${provider} session ` +
    `holds this call's conversation context server-side for the duration of the call.`
  );
}
