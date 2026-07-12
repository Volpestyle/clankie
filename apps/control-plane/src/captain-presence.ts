import { createHash } from "node:crypto";
import {
  CAPTAIN_STATUS_SUBJECT_ID,
  CaptainPresenceEventSchema,
  CaptainPresenceReportSchema,
  type CaptainPresenceEvent,
  type CaptainPresenceReport,
  type DomainEvent,
} from "@clankie/protocol";

export const CAPTAIN_PRESENCE_MISSION_ID = "captain-presence";

export interface CaptainPresenceLease {
  readonly captainId: string;
  readonly leaseId: string;
  readonly generationId: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly state: "live" | "offline";
}

export interface CaptainPresenceEmission {
  readonly event: CaptainPresenceEvent;
  readonly eventKey: string;
}

export interface CaptainPresenceResult {
  readonly lease: CaptainPresenceLease;
  readonly emitted: readonly CaptainPresenceEvent[];
}

export interface CaptainPresenceManagerOptions {
  readonly profileHash: string;
  readonly emit: (emission: CaptainPresenceEmission) => Promise<void>;
  readonly replayEvents?: readonly DomainEvent[];
  readonly clock?: () => Date;
  readonly leaseDurationMs?: number;
  readonly recordedHeartbeatIntervalMs?: number;
  readonly scheduleExpiry?: boolean;
  readonly onBackgroundError?: (error: unknown) => void;
}

interface MutableCaptainPresenceLease {
  captainId: string;
  leaseId: string;
  generationId: string;
  heartbeatAt: string;
  expiresAt: string;
  state: "live" | "offline";
}

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RECORDED_HEARTBEAT_INTERVAL_MS = 10_000;

export class CaptainPresenceLeaseConflictError extends Error {
  public constructor() {
    super("A different captain identity cannot renew the live captain lease");
    this.name = "CaptainPresenceLeaseConflictError";
  }
}

export class CaptainPresenceManager {
  private readonly profileHash: string;
  private readonly emitEvent: CaptainPresenceManagerOptions["emit"];
  private readonly clock: () => Date;
  private readonly leaseDurationMs: number;
  private readonly recordedHeartbeatIntervalMs: number;
  private readonly scheduleExpiry: boolean;
  private readonly onBackgroundError: (error: unknown) => void;
  private readonly recordedEventIds = new Set<string>();
  private readonly acceptedReportIds = new Set<string>();
  private current: MutableCaptainPresenceLease | undefined;
  private lastRecordedHeartbeatAt: string | undefined;
  private expirationTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: CaptainPresenceManagerOptions) {
    if (!Number.isSafeInteger(options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS)) {
      throw new Error("Captain lease duration must be a safe integer");
    }
    if (
      !Number.isSafeInteger(options.recordedHeartbeatIntervalMs ?? DEFAULT_RECORDED_HEARTBEAT_INTERVAL_MS)
    ) {
      throw new Error("Captain recorded-heartbeat interval must be a safe integer");
    }
    this.profileHash = options.profileHash;
    this.emitEvent = options.emit;
    this.clock = options.clock ?? (() => new Date());
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.recordedHeartbeatIntervalMs =
      options.recordedHeartbeatIntervalMs ?? DEFAULT_RECORDED_HEARTBEAT_INTERVAL_MS;
    if (this.leaseDurationMs <= 0 || this.recordedHeartbeatIntervalMs <= 0) {
      throw new Error("Captain presence intervals must be positive");
    }
    if (this.recordedHeartbeatIntervalMs >= this.leaseDurationMs) {
      throw new Error("Captain heartbeat records must be more frequent than lease expiry");
    }
    this.scheduleExpiry = options.scheduleExpiry ?? true;
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
    this.replay(options.replayEvents ?? []);
    this.schedule();
  }

  public receive(captainId: string, input: unknown): Promise<CaptainPresenceResult> {
    return this.enqueue(async () => {
      const report = CaptainPresenceReportSchema.parse(input);
      const reportId = reportEventId(report);
      const duplicate = this.acceptedReportIds.has(reportId) || this.recordedEventIds.has(reportId);
      const now = this.clock();
      await this.expireAt(now);
      const emitted: CaptainPresenceEvent[] = [];
      const lease = await this.renew(captainId, report, now, emitted, duplicate);
      if (!duplicate) {
        const event = this.lifecycleEvent(captainId, report, lease);
        if (event !== undefined) {
          await this.emit(event, report.eventId);
          emitted.push(event);
        }
      }
      this.acceptedReportIds.add(reportId);
      this.schedule();
      return { lease: copyLease(lease), emitted };
    });
  }

  public expireStale(): Promise<CaptainPresenceEvent | undefined> {
    return this.enqueue(async () => {
      const emitted = await this.expireAt(this.clock());
      this.schedule();
      return emitted;
    });
  }

  public snapshot(): CaptainPresenceLease | undefined {
    return this.current === undefined ? undefined : copyLease(this.current);
  }

  public close(): void {
    if (this.expirationTimer !== undefined) clearTimeout(this.expirationTimer);
    this.expirationTimer = undefined;
  }

  private async renew(
    captainId: string,
    report: CaptainPresenceReport,
    now: Date,
    emitted: CaptainPresenceEvent[],
    duplicate: boolean,
  ): Promise<MutableCaptainPresenceLease> {
    const current = this.current;
    const isNewGeneration =
      current === undefined ||
      current.state === "offline" ||
      current.generationId !== report.generationId ||
      current.leaseId !== report.leaseId;
    if (
      current?.state === "live" &&
      (current.captainId !== captainId ||
        (current.generationId === report.generationId && current.leaseId !== report.leaseId))
    ) {
      throw new CaptainPresenceLeaseConflictError();
    }
    if (current?.state === "live" && current.generationId !== report.generationId) {
      const offline = this.offlineEvent(current, now, "superseded");
      await this.emit(offline, `offline:${current.generationId}:${current.leaseId}`);
      emitted.push(offline);
    }

    const next: MutableCaptainPresenceLease = {
      captainId,
      leaseId: report.leaseId,
      generationId: report.generationId,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
      state: "live",
    };
    if (isNewGeneration) {
      const online = this.onlineEvent(next, now);
      await this.emit(online, `online:${next.generationId}:${next.leaseId}`);
      emitted.push(online);
      this.lastRecordedHeartbeatAt = now.toISOString();
      if (report.type === "captain.heartbeat" && !duplicate) {
        const heartbeat = this.heartbeatEvent(next, now, `${report.generationId}:${report.eventId}`);
        await this.emit(heartbeat, report.eventId);
        emitted.push(heartbeat);
      }
    } else if (report.type === "captain.heartbeat" && this.heartbeatRecordDue(now) && !duplicate) {
      const heartbeat = this.heartbeatEvent(next, now, `${report.generationId}:${report.eventId}`);
      await this.emit(heartbeat, report.eventId);
      emitted.push(heartbeat);
      this.lastRecordedHeartbeatAt = now.toISOString();
    }
    this.current = next;
    return next;
  }

  private lifecycleEvent(
    captainId: string,
    report: CaptainPresenceReport,
    lease: CaptainPresenceLease,
  ): CaptainPresenceEvent | undefined {
    if (report.type === "captain.heartbeat") return undefined;
    const common = {
      schemaVersion: 1 as const,
      subjectId: CAPTAIN_STATUS_SUBJECT_ID,
      captainId,
      leaseId: lease.leaseId,
      generationId: lease.generationId,
      sessionId: report.sessionId,
      turnId: report.turnId,
      tier: 0 as const,
      source: "eve.lifecycle" as const,
      confidence: 1 as const,
      observedAt: report.occurredAt,
    };
    const data =
      report.type === "captain.turn.started"
        ? { ...common, state: "working" as const }
        : report.type === "captain.waiting_dependency"
          ? { ...common, state: "waiting_dependency" as const, summary: report.summary }
          : report.state === "waiting_user"
            ? {
                ...common,
                state: "waiting_user" as const,
                questionSummary: report.questionSummary,
              }
            : { ...common, state: "idle" as const };
    return CaptainPresenceEventSchema.parse({
      id: reportEventId(report),
      occurredAt: report.occurredAt,
      missionId: CAPTAIN_PRESENCE_MISSION_ID,
      correlationId: report.generationId,
      causationId: report.turnId,
      profileHash: this.profileHash,
      type: report.type,
      data,
    });
  }

  private onlineEvent(lease: CaptainPresenceLease, now: Date): CaptainPresenceEvent {
    return this.leaseEvent("captain.presence.online", lease, now, "idle");
  }

  private heartbeatEvent(
    lease: CaptainPresenceLease,
    now: Date,
    reportEventId: string,
  ): CaptainPresenceEvent {
    return this.leaseEvent("captain.heartbeat", lease, now, "idle", undefined, reportEventId);
  }

  private offlineEvent(
    lease: CaptainPresenceLease,
    now: Date,
    reason: "lease_expired" | "superseded",
  ): CaptainPresenceEvent {
    return this.leaseEvent("captain.presence.offline", lease, now, "offline", reason);
  }

  private leaseEvent(
    type: "captain.presence.online" | "captain.presence.offline" | "captain.heartbeat",
    lease: CaptainPresenceLease,
    now: Date,
    state: "idle" | "offline",
    reason?: "lease_expired" | "superseded",
    idempotencyKey?: string,
  ): CaptainPresenceEvent {
    const key = idempotencyKey ?? `${type}:${lease.generationId}:${lease.leaseId}:${lease.heartbeatAt}`;
    return CaptainPresenceEventSchema.parse({
      id: eventId(key),
      occurredAt: now.toISOString(),
      missionId: CAPTAIN_PRESENCE_MISSION_ID,
      correlationId: lease.generationId,
      profileHash: this.profileHash,
      type,
      data: {
        schemaVersion: 1,
        subjectId: CAPTAIN_STATUS_SUBJECT_ID,
        captainId: lease.captainId,
        leaseId: lease.leaseId,
        generationId: lease.generationId,
        heartbeatAt: lease.heartbeatAt,
        expiresAt: lease.expiresAt,
        state,
        tier: 1,
        source: "control-plane.captain_lease",
        confidence: 1,
        observedAt: now.toISOString(),
        ...(reason === undefined ? {} : { reason }),
      },
    });
  }

  private async expireAt(now: Date): Promise<CaptainPresenceEvent | undefined> {
    const lease = this.current;
    if (lease === undefined || lease.state === "offline" || Date.parse(lease.expiresAt) > now.getTime()) {
      return undefined;
    }
    const event = this.offlineEvent(lease, now, "lease_expired");
    await this.emit(event, `offline:${lease.generationId}:${lease.leaseId}`);
    lease.state = "offline";
    return event;
  }

  private heartbeatRecordDue(now: Date): boolean {
    return (
      this.lastRecordedHeartbeatAt === undefined ||
      now.getTime() - Date.parse(this.lastRecordedHeartbeatAt) >= this.recordedHeartbeatIntervalMs
    );
  }

  private async emit(event: CaptainPresenceEvent, eventKey: string): Promise<void> {
    if (this.recordedEventIds.has(event.id)) return;
    await this.emitEvent({ event, eventKey });
    this.recordedEventIds.add(event.id);
  }

  private replay(events: readonly DomainEvent[]): void {
    for (const candidate of events) {
      const parsed = CaptainPresenceEventSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const event = parsed.data;
      this.recordedEventIds.add(event.id);
      if (event.type === "captain.presence.online" || event.type === "captain.heartbeat") {
        this.current = {
          captainId: event.data.captainId,
          leaseId: event.data.leaseId,
          generationId: event.data.generationId,
          heartbeatAt: event.data.heartbeatAt,
          expiresAt: event.data.expiresAt,
          state: "live",
        };
        this.lastRecordedHeartbeatAt = event.data.heartbeatAt;
      } else if (event.type === "captain.presence.offline" && this.current !== undefined) {
        if (
          this.current.generationId === event.data.generationId &&
          this.current.leaseId === event.data.leaseId
        ) {
          this.current.state = "offline";
        }
      }
    }
  }

  private schedule(): void {
    if (!this.scheduleExpiry) return;
    if (this.expirationTimer !== undefined) clearTimeout(this.expirationTimer);
    this.expirationTimer = undefined;
    if (this.current === undefined || this.current.state !== "live") return;
    const delay = Math.max(0, Date.parse(this.current.expiresAt) - this.clock().getTime());
    this.expirationTimer = setTimeout(() => {
      void this.expireStale().catch(this.onBackgroundError);
    }, delay);
    this.expirationTimer.unref();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function eventId(eventKey: string): string {
  return createHash("sha256").update(`captain-presence\0${eventKey}`).digest("hex");
}

function reportEventId(report: Pick<CaptainPresenceReport, "eventId" | "generationId">): string {
  return eventId(`${report.generationId}:${report.eventId}`);
}

function copyLease(lease: CaptainPresenceLease): CaptainPresenceLease {
  return { ...lease };
}
