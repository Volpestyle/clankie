import { CaptainLaneSchema, type CaptainLane } from "@clankie/protocol";

export interface CaptainIdentity {
  readonly agentDefinitionId: string;
  readonly soulId: string;
  readonly providerId: string;
  readonly characterId: string;
}

export interface CaptainLaneAddress {
  readonly characterId: string;
  readonly lane: CaptainLane;
  readonly targetId: string;
}

export type CaptainLaneSessionState = "active" | "waiting" | "completed" | "failed";

export interface CaptainLaneSnapshot extends CaptainLaneAddress {
  readonly key: string;
  readonly sessionId?: string;
  readonly state: CaptainLaneSessionState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CaptainLaneResumeState extends CaptainLaneSnapshot {
  readonly continuationToken?: string;
}

export type CaptainRuntimeEventType =
  | "lane.registered"
  | "lane.restored"
  | "lane.session.bound"
  | "lane.session.state_changed"
  | "admission.queued"
  | "admission.admitted"
  | "admission.preempt_requested"
  | "admission.parked"
  | "admission.released";

/** Redacted runtime evidence. Continuation tokens are deliberately impossible to attach. */
export interface CaptainRuntimeEvent {
  readonly type: CaptainRuntimeEventType;
  readonly occurredAt: string;
  readonly laneKey: string;
  readonly lane: CaptainLane;
  readonly requestId?: string;
  readonly reason?: string;
  readonly queueSequence?: number;
}

export type CaptainRuntimeEventSink = (event: CaptainRuntimeEvent) => void | Promise<void>;

export function captainLaneKey(address: CaptainLaneAddress): string {
  const lane = CaptainLaneSchema.parse(address.lane);
  const characterId = boundedIdentifier(address.characterId, "Character id");
  const targetId = boundedIdentifier(address.targetId, "Lane target id");
  return JSON.stringify([characterId, lane, targetId]);
}

export function parseCaptainLaneAddress(input: CaptainLaneAddress): CaptainLaneAddress {
  return {
    characterId: boundedIdentifier(input.characterId, "Character id"),
    lane: CaptainLaneSchema.parse(input.lane),
    targetId: boundedIdentifier(input.targetId, "Lane target id"),
  };
}

export function validateCaptainIdentity(identity: CaptainIdentity): CaptainIdentity {
  return {
    agentDefinitionId: boundedIdentifier(identity.agentDefinitionId, "Agent definition id"),
    soulId: boundedIdentifier(identity.soulId, "Soul id"),
    providerId: boundedIdentifier(identity.providerId, "Provider id"),
    characterId: boundedIdentifier(identity.characterId, "Character id"),
  };
}

function boundedIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) {
    throw new Error(`${label} must contain 1 to 512 characters`);
  }
  return normalized;
}
