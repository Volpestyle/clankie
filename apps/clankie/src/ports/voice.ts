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
