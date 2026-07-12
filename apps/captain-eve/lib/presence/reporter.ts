import type { CaptainPresenceReport } from "@clankie/protocol";

export interface CaptainPresenceTransport {
  send(report: CaptainPresenceReport): Promise<void>;
}

export interface CaptainPresenceReporterOptions {
  readonly transport: CaptainPresenceTransport;
  readonly leaseId: string;
  readonly generationId: string;
  readonly clock?: () => Date;
  readonly heartbeatIntervalMs?: number;
  readonly scheduleHeartbeats?: boolean;
  readonly onBackgroundError?: (error: unknown) => void;
}

interface SessionPresence {
  readonly pendingInputCalls: Map<string, string>;
  readonly dependencies: Map<string, string>;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export class CaptainPresenceReporter {
  private readonly transport: CaptainPresenceTransport;
  private readonly leaseId: string;
  private readonly generationId: string;
  private readonly clock: () => Date;
  private readonly heartbeatIntervalMs: number;
  private readonly scheduleHeartbeats: boolean;
  private readonly onBackgroundError: (error: unknown) => void;
  private readonly sessions = new Map<string, SessionPresence>();
  private queue: Promise<unknown> = Promise.resolve();
  private startPromise: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  public constructor(options: CaptainPresenceReporterOptions) {
    if (!Number.isSafeInteger(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS)) {
      throw new Error("Captain heartbeat interval must be a safe integer");
    }
    this.transport = options.transport;
    this.leaseId = options.leaseId;
    this.generationId = options.generationId;
    this.clock = options.clock ?? (() => new Date());
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (this.heartbeatIntervalMs <= 0) throw new Error("Captain heartbeat interval must be positive");
    this.scheduleHeartbeats = options.scheduleHeartbeats ?? true;
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
  }

  public start(): Promise<void> {
    this.startPromise ??= this.sendHeartbeat().catch((error: unknown) => {
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  public async turnStarted(input: {
    sessionId: string;
    turnId: string;
    eventId: string;
    occurredAt: string;
  }): Promise<void> {
    await this.start();
    this.session(input.sessionId).pendingInputCalls.clear();
    await this.send({
      ...this.reportBase(input.eventId, input.occurredAt),
      type: "captain.turn.started",
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
  }

  public async waitingUser(input: {
    sessionId: string;
    turnId: string;
    eventId: string;
    occurredAt: string;
    requests: readonly { callId: string; summary: string }[];
  }): Promise<void> {
    await this.start();
    const session = this.session(input.sessionId);
    for (const request of input.requests) session.pendingInputCalls.set(request.callId, request.summary);
    const questionSummary = [...session.pendingInputCalls.values()].join("; ").slice(0, 512);
    if (questionSummary.length === 0) throw new Error("Captain waiting_user requires a bounded summary");
    await this.send({
      ...this.reportBase(input.eventId, input.occurredAt),
      type: "captain.turn.settled",
      sessionId: input.sessionId,
      turnId: input.turnId,
      state: "waiting_user",
      questionSummary,
    });
  }

  public async inputResolved(input: {
    sessionId: string;
    turnId: string;
    eventId: string;
    occurredAt: string;
    callId: string;
  }): Promise<void> {
    const pending = this.session(input.sessionId).pendingInputCalls;
    if (!pending.delete(input.callId) || pending.size > 0) return;
    await this.turnStarted(input);
  }

  public noteDependency(sessionId: string, dependencyId: string, summary: string): void {
    this.session(sessionId).dependencies.set(dependencyId, summary.slice(0, 512));
  }

  public resolveDependency(sessionId: string, dependencyId: string): void {
    this.session(sessionId).dependencies.delete(dependencyId);
  }

  public async sessionWaiting(input: {
    sessionId: string;
    turnId: string;
    eventId: string;
    occurredAt: string;
  }): Promise<void> {
    await this.start();
    const session = this.session(input.sessionId);
    if (session.pendingInputCalls.size > 0) return;
    if (session.dependencies.size > 0) {
      await this.send({
        ...this.reportBase(input.eventId, input.occurredAt),
        type: "captain.waiting_dependency",
        sessionId: input.sessionId,
        turnId: input.turnId,
        summary: [...session.dependencies.values()].join("; ").slice(0, 512),
      });
      return;
    }
    await this.send({
      ...this.reportBase(input.eventId, input.occurredAt),
      type: "captain.turn.settled",
      sessionId: input.sessionId,
      turnId: input.turnId,
      state: "idle",
    });
  }

  public async sessionSettled(input: {
    sessionId: string;
    turnId: string;
    eventId: string;
    occurredAt: string;
  }): Promise<void> {
    await this.start();
    this.sessions.delete(input.sessionId);
    await this.send({
      ...this.reportBase(input.eventId, input.occurredAt),
      type: "captain.turn.settled",
      sessionId: input.sessionId,
      turnId: input.turnId,
      state: "idle",
    });
  }

  public close(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private sendHeartbeat(): Promise<void> {
    const occurredAt = this.clock().toISOString();
    return this.send({
      ...this.reportBase(`heartbeat:${occurredAt}`, occurredAt),
      type: "captain.heartbeat",
    }).then(() => {
      if (!this.scheduleHeartbeats || this.heartbeatTimer !== undefined) return;
      this.heartbeatTimer = setInterval(() => {
        void this.sendHeartbeat().catch(this.onBackgroundError);
      }, this.heartbeatIntervalMs);
      this.heartbeatTimer.unref();
    });
  }

  private reportBase(eventId: string, occurredAt: string) {
    return {
      schemaVersion: 1 as const,
      eventId,
      leaseId: this.leaseId,
      generationId: this.generationId,
      occurredAt,
    };
  }

  private send(report: CaptainPresenceReport): Promise<void> {
    const result = this.queue.then(
      () => this.transport.send(report),
      () => this.transport.send(report),
    );
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private session(sessionId: string): SessionPresence {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionPresence = { pendingInputCalls: new Map(), dependencies: new Map() };
    this.sessions.set(sessionId, created);
    return created;
  }
}
