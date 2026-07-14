import {
  DiscordPresencePhaseEventSchema,
  DiscordPresenceSessionRecordSchema,
  type DiscordPresencePhaseEvent,
  type DiscordPresencePhaseTransitionReason,
  type DiscordPresenceSessionPhase,
  type DiscordPresenceSessionRecord,
} from "@clankie/interactive-environment";
import { randomUUID } from "node:crypto";

export interface DiscordPresenceSessionOptions {
  sessionId: string;
  characterId: string;
  credentialRef: string;
  transportKind: "bot" | "user_session";
  emit: (event: DiscordPresencePhaseEvent) => void | Promise<void>;
  clock?: () => Date;
  idFactory?: () => string;
}

/**
 * Single-writer gateway/voice lifecycle owned by the Discord bridge process.
 * Consumers receive typed phase events; terminal output is never an authority source.
 */
export class DiscordPresenceSession {
  private readonly emitEvent: DiscordPresenceSessionOptions["emit"];
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly voiceGuildIds = new Set<string>();
  private recordValue: DiscordPresenceSessionRecord;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: DiscordPresenceSessionOptions) {
    this.emitEvent = options.emit;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.recordValue = DiscordPresenceSessionRecordSchema.parse({
      schemaVersion: 1,
      sessionId: options.sessionId,
      characterId: options.characterId,
      credentialRef: options.credentialRef,
      transportKind: options.transportKind,
      phase: "off",
      gatewayConnected: false,
      voiceGuildIds: [],
      revision: 0,
      updatedAt: this.clock().toISOString(),
    });
  }

  public get record(): DiscordPresenceSessionRecord {
    return structuredClone(this.recordValue);
  }

  public start(): Promise<DiscordPresenceSessionRecord> {
    return this.transition("connecting", "process_start", false);
  }

  public gatewayReady(): Promise<DiscordPresenceSessionRecord> {
    return this.activate("gateway_ready");
  }

  public gatewayResumed(): Promise<DiscordPresenceSessionRecord> {
    return this.activate("gateway_resumed");
  }

  public gatewayReconnecting(): Promise<DiscordPresenceSessionRecord> {
    return this.transition("connecting", "gateway_reconnecting", false);
  }

  public gatewayDisconnected(): Promise<DiscordPresenceSessionRecord> {
    return this.transition("degraded", "gateway_disconnected", false);
  }

  public leaseLost(): Promise<DiscordPresenceSessionRecord> {
    return this.transition("degraded", "lease_lost", false);
  }

  public fail(): Promise<DiscordPresenceSessionRecord> {
    return this.transition("failed", "gateway_failed", false);
  }

  public stop(): Promise<DiscordPresenceSessionRecord> {
    return this.transition("off", "process_stopped", false);
  }

  public voiceStateChanged(guildId: string, connected: boolean): Promise<DiscordPresenceSessionRecord> {
    return this.enqueue(async () => {
      if (connected) this.voiceGuildIds.add(guildId);
      else this.voiceGuildIds.delete(guildId);
      if (!this.recordValue.gatewayConnected) return this.record;
      return this.applyTransition(this.activePhase(), connected ? "voice_joined" : "voice_left", true);
    });
  }

  private activePhase(): DiscordPresenceSessionPhase {
    return this.voiceGuildIds.size > 0 ? "voice_active" : "present";
  }

  private activate(reason: "gateway_ready" | "gateway_resumed"): Promise<DiscordPresenceSessionRecord> {
    return this.enqueue(() => this.applyTransition(this.activePhase(), reason, true));
  }

  private transition(
    phase: DiscordPresenceSessionPhase,
    reason: DiscordPresencePhaseTransitionReason,
    gatewayConnected: boolean,
  ): Promise<DiscordPresenceSessionRecord> {
    return this.enqueue(() => {
      if (!gatewayConnected) this.voiceGuildIds.clear();
      return this.applyTransition(phase, reason, gatewayConnected);
    });
  }

  private async applyTransition(
    phase: DiscordPresenceSessionPhase,
    reason: DiscordPresencePhaseTransitionReason,
    gatewayConnected: boolean,
  ): Promise<DiscordPresenceSessionRecord> {
    const previousPhase = this.recordValue.phase;
    if (previousPhase === phase && this.recordValue.gatewayConnected === gatewayConnected) {
      return this.record;
    }
    const occurredAt = this.clock().toISOString();
    this.recordValue = DiscordPresenceSessionRecordSchema.parse({
      ...this.recordValue,
      phase,
      gatewayConnected,
      voiceGuildIds: [...this.voiceGuildIds].sort(),
      revision: this.recordValue.revision + 1,
      updatedAt: occurredAt,
    });
    const event = DiscordPresencePhaseEventSchema.parse({
      schemaVersion: 1,
      plane: "semantic",
      id: this.idFactory(),
      type: "discord.presence.session.phase_changed",
      occurredAt,
      correlationId: this.recordValue.sessionId,
      sessionId: this.recordValue.sessionId,
      data: {
        previousPhase,
        phase,
        reason,
        session: this.recordValue,
      },
    });
    await this.emitEvent(event);
    return this.record;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
