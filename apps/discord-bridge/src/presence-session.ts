import {
  DiscordPresencePhaseEventSchema,
  DiscordPresenceSessionRecordSchema,
  resolveDiscordPresenceToolExposure,
  type DiscordPresenceToolExposure,
  type DiscordPresencePhaseEvent,
  type DiscordPresencePhaseTransitionReason,
  type DiscordPresenceSessionPhase,
  type DiscordPresenceSessionRecord,
} from "@clankie/interactive-environment";
import type { CaptainLane } from "@clankie/protocol";
import { randomUUID } from "node:crypto";

export interface DiscordPresenceSessionOptions {
  sessionId: string;
  characterId: string;
  credentialRef: string;
  transportKind: "bot" | "user_session";
  emit: (
    event: DiscordPresencePhaseEvent,
  ) => DiscordPresenceSessionRecord | void | Promise<DiscordPresenceSessionRecord | void>;
  clock?: () => Date;
  idFactory?: () => string;
  retryDelayMs?: number;
  maxPublicationAttempts?: number;
  onPublicationFailure?: (error: unknown, event: DiscordPresencePhaseEvent) => void;
  onTerminalFailure?: (
    error: DiscordPresencePublicationTerminalError,
    event: DiscordPresencePhaseEvent,
  ) => void;
}

export type DiscordPresencePublicationFailureDisposition = "transient" | "permanent";

/** Typed transport rejection so retry policy never depends on log text. */
export class DiscordPresencePublicationError extends Error {
  public readonly disposition: DiscordPresencePublicationFailureDisposition;

  public constructor(
    disposition: DiscordPresencePublicationFailureDisposition,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "DiscordPresencePublicationError";
    this.disposition = disposition;
  }
}

/** Terminal lifecycle outcome after a permanent rejection or exhausted transient retry budget. */
export class DiscordPresencePublicationTerminalError extends Error {
  public readonly attempts: number;
  public readonly disposition: DiscordPresencePublicationFailureDisposition;

  public constructor(
    disposition: DiscordPresencePublicationFailureDisposition,
    attempts: number,
    options: ErrorOptions = {},
  ) {
    super(`Discord presence phase publication terminated after ${String(attempts)} attempt(s)`, options);
    this.name = "DiscordPresencePublicationTerminalError";
    this.disposition = disposition;
    this.attempts = attempts;
  }
}

/** Live advertised catalog. Consumers retain this object while phase changes replace its snapshot. */
export class DiscordPresenceAdvertisedToolCatalog {
  private value: DiscordPresenceToolExposure;

  public constructor(session: DiscordPresenceSessionRecord, lane: CaptainLane) {
    this.value = resolveDiscordPresenceToolExposure(session, lane);
  }

  public get current(): DiscordPresenceToolExposure {
    return structuredClone(this.value);
  }

  public update(session: DiscordPresenceSessionRecord): void {
    this.value = resolveDiscordPresenceToolExposure(session, this.value.lane);
  }
}

/**
 * Single-writer gateway/voice lifecycle owned by the Discord bridge process.
 * Consumers receive typed phase events; terminal output is never an authority source.
 */
export class DiscordPresenceSession {
  private readonly emitEvent: DiscordPresenceSessionOptions["emit"];
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly retryDelayMs: number;
  private readonly maxPublicationAttempts: number;
  private readonly onPublicationFailure: NonNullable<DiscordPresenceSessionOptions["onPublicationFailure"]>;
  private readonly onTerminalFailure: NonNullable<DiscordPresenceSessionOptions["onTerminalFailure"]>;
  private readonly voiceGuildIds = new Set<string>();
  private readonly toolCatalogs = new Map<CaptainLane, DiscordPresenceAdvertisedToolCatalog>();
  private recordValue: DiscordPresenceSessionRecord;
  private liveRecordValue: DiscordPresenceSessionRecord;
  private terminalError: DiscordPresencePublicationTerminalError | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: DiscordPresenceSessionOptions) {
    this.emitEvent = options.emit;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.maxPublicationAttempts = options.maxPublicationAttempts ?? 5;
    if (!Number.isInteger(this.maxPublicationAttempts) || this.maxPublicationAttempts < 1) {
      throw new Error("Discord presence maxPublicationAttempts must be a positive integer");
    }
    this.onPublicationFailure = options.onPublicationFailure ?? (() => undefined);
    this.onTerminalFailure = options.onTerminalFailure ?? (() => undefined);
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
    this.liveRecordValue = this.recordValue;
    this.toolCatalogs.set(
      "discord_presence",
      new DiscordPresenceAdvertisedToolCatalog(this.recordValue, "discord_presence"),
    );
  }

  public get record(): DiscordPresenceSessionRecord {
    return structuredClone(this.recordValue);
  }

  /** Immediate gateway truth used by the production action advertiser before durability catches up. */
  public get liveRecord(): DiscordPresenceSessionRecord {
    return structuredClone(this.liveRecordValue);
  }

  public toolCatalog(lane: CaptainLane): DiscordPresenceAdvertisedToolCatalog {
    const existing = this.toolCatalogs.get(lane);
    if (existing !== undefined) return existing;
    const catalog = new DiscordPresenceAdvertisedToolCatalog(this.recordValue, lane);
    this.toolCatalogs.set(lane, catalog);
    return catalog;
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
    this.fenceAdvertisedToolLoss(phase, gatewayConnected);
    return this.enqueue(() => {
      if (!gatewayConnected) this.voiceGuildIds.clear();
      return this.applyTransition(phase, reason, gatewayConnected);
    });
  }

  private fenceAdvertisedToolLoss(phase: DiscordPresenceSessionPhase, gatewayConnected: boolean): void {
    const preview = DiscordPresenceSessionRecordSchema.parse({
      ...this.recordValue,
      phase,
      gatewayConnected,
      voiceGuildIds: gatewayConnected ? [...this.voiceGuildIds].sort() : [],
    });
    if (this.revokesActCapability(preview)) {
      this.liveRecordValue = preview;
      this.updateToolCatalogs(preview);
    }
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
    const candidate = DiscordPresenceSessionRecordSchema.parse({
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
      correlationId: candidate.sessionId,
      sessionId: candidate.sessionId,
      data: {
        previousPhase,
        phase,
        reason,
        session: candidate,
      },
    });
    // Mirror the environment runtime's synchronous revoke fence: capability loss
    // becomes visible before the first publication await, so a retained catalog
    // cannot advertise act tools while durability is being retried.
    if (this.revokesActCapability(candidate)) this.updateToolCatalogs(candidate);
    try {
      this.recordValue = await this.publishUntilAccepted(event, candidate);
      this.liveRecordValue = this.recordValue;
      this.updateToolCatalogs(this.recordValue);
      return this.record;
    } catch (error) {
      if (!(error instanceof DiscordPresencePublicationTerminalError)) throw error;
      const terminalEvent = this.terminalFailureEvent();
      this.recordValue = terminalEvent.data.session;
      this.liveRecordValue = this.recordValue;
      this.updateToolCatalogs(this.recordValue);
      this.terminalError = error;
      this.onTerminalFailure(error, terminalEvent);
      throw error;
    }
  }

  private revokesActCapability(candidate: DiscordPresenceSessionRecord): boolean {
    const current = this.toolCatalog("discord_presence").current.presenceTools;
    const next = resolveDiscordPresenceToolExposure(candidate, "discord_presence").presenceTools;
    return current.includes("discord_presence_act") && !next.includes("discord_presence_act");
  }

  private updateToolCatalogs(session: DiscordPresenceSessionRecord): void {
    for (const catalog of this.toolCatalogs.values()) catalog.update(session);
  }

  private async publishUntilAccepted(
    event: DiscordPresencePhaseEvent,
    candidate: DiscordPresenceSessionRecord,
  ): Promise<DiscordPresenceSessionRecord> {
    for (let attempt = 1; attempt <= this.maxPublicationAttempts; attempt += 1) {
      try {
        return DiscordPresenceSessionRecordSchema.parse((await this.emitEvent(event)) ?? candidate);
      } catch (error) {
        this.onPublicationFailure(error, event);
        const disposition = publicationFailureDisposition(error);
        if (disposition === "permanent" || attempt === this.maxPublicationAttempts) {
          throw new DiscordPresencePublicationTerminalError(disposition, attempt, { cause: error });
        }
        const backoffMs = this.retryDelayMs * 2 ** (attempt - 1);
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    throw new Error("unreachable Discord presence publication retry state");
  }

  private terminalFailureEvent(): DiscordPresencePhaseEvent {
    const occurredAt = this.clock().toISOString();
    const session = DiscordPresenceSessionRecordSchema.parse({
      ...this.recordValue,
      phase: "failed",
      gatewayConnected: false,
      voiceGuildIds: [],
      revision: this.recordValue.revision + 1,
      updatedAt: occurredAt,
    });
    return DiscordPresencePhaseEventSchema.parse({
      schemaVersion: 1,
      plane: "semantic",
      id: this.idFactory(),
      type: "discord.presence.session.phase_changed",
      occurredAt,
      correlationId: session.sessionId,
      sessionId: session.sessionId,
      data: {
        previousPhase: this.recordValue.phase,
        phase: "failed",
        reason: "publication_failed",
        session,
      },
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.terminalError !== undefined) return Promise.reject(this.terminalError);
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function publicationFailureDisposition(error: unknown): DiscordPresencePublicationFailureDisposition {
  if (error instanceof DiscordPresencePublicationError) return error.disposition;
  if (error instanceof TypeError || (error instanceof Error && error.name === "AbortError"))
    return "transient";
  if (error instanceof Error) {
    const status = /Clankie API (\d{3}):/u.exec(error.message)?.[1];
    if (status !== undefined) {
      const code = Number(status);
      return code === 408 || code === 425 || code === 429 || code >= 500 ? "transient" : "permanent";
    }
  }
  return "permanent";
}
