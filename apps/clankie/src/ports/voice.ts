import type {
  BodyLeaseResult,
  BodyVoiceReconcileRequest,
  BodyVoiceStay,
  BodyVoiceSubject,
  BodyVoiceTarget,
  CaptainChannelTurnResult,
} from "@clankie/protocol";
import type { BodyConversationIdentity } from "../body-lease-router.ts";
import type { ConversationStore } from "../captain/conversations.ts";

/**
 * What the core reads of his recent Discord speech, for `get_self_state`: whether
 * he spoke, whether play commentary was dropped, and the receipt's scalars, never
 * words. The voice extension fills it (ADR 0328).
 */

export interface VoiceSpeechScalar {
  readonly occurredAt: string;
  readonly kind: "spoken" | "suppressed";
  readonly deliveryId?: string;
  readonly stayId?: string;
  readonly trigger?: string;
  readonly wake?: string;
  readonly playbackMs?: number;
  readonly toFirstAudioMs?: number;
  readonly reason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

interface VoiceStaySpeechSummary {
  readonly stayId?: string;
  readonly spoken: number;
  readonly suppressed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface VoiceSpeechSnapshot {
  readonly recent: readonly VoiceSpeechScalar[];
  readonly currentStay?: VoiceStaySpeechSummary;
}

/** Where a voice is: a Discord voice channel, or a private call from the owner's own device (VUH-2682). */
export type VoiceSurface = "discord" | "call";

/**
 * What the voice extension gives the captain (ADR 0328): how the realtime voice
 * is told who it is, and a device call's handoff and transcript in the main
 * conversation. Absent while voice is off.
 */
export interface CaptainVoice {
  /** The voice lane's instructions, built from the captain's own instructions file. */
  laneInstructions(captainInstructions: string, surface: VoiceSurface): string;
  /** A device call's `ask_clankie`, as one turn in the main conversation. */
  callHandoff(
    conversations: Pick<ConversationStore, "defaultGlobalConversationId" | "replyToLinkedChannel">,
    shutdown: AbortSignal,
    input: { readonly deliveryId: string; readonly request: string; readonly context?: string },
  ): Promise<CaptainChannelTurnResult>;
  /** A line said on a device call, recorded in the main conversation. */
  callTranscript(
    conversations: Pick<ConversationStore, "defaultGlobalConversationId" | "recordVoiceCallLine">,
    input: { readonly speaker: "owner" | "clankie"; readonly text: string },
  ): Promise<boolean>;
}

/**
 * The Discord body's voice stays as the core's body routes use them: tickets,
 * claims, heartbeats and audio-source checks. The voice extension's
 * `BodyVoiceStays` supplies it (ADR 0328).
 */
export interface BodyVoiceStaysPort {
  ticket(
    identity: BodyConversationIdentity,
    target: BodyVoiceTarget,
    kind?: "audio" | "publish",
  ): Promise<{ ticket: string } | BodyLeaseResult>;
  claim(
    stay: BodyVoiceStay,
    routeIdentity: BodyConversationIdentity,
    ticketId?: string,
    subject?: BodyVoiceSubject,
  ): Promise<BodyLeaseResult>;
  heartbeat(
    stay: BodyVoiceStay,
    incarnation: string,
    routeIdentity: BodyConversationIdentity,
  ): Promise<BodyLeaseResult>;
  finish(stay: BodyVoiceStay, incarnation: string): BodyLeaseResult;
  observesAudioSource(input: {
    stayId: string;
    guildId: string;
    channelId: string;
    presenceSessionId: string;
  }): boolean;
  compatibleTarget(conversationId: string, target: BodyVoiceTarget): boolean;
  publishing(conversationId: string): BodyVoiceStay | undefined;
  authorizeReconciliation(request: BodyVoiceReconcileRequest, presenceSessionId: string): Promise<boolean>;
}
