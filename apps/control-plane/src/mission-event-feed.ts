import { createHmac, timingSafeEqual } from "node:crypto";
import { GENESIS_HASH, seal, verifyChain, type StoredEvent } from "@clankie/event-store";
import {
  ActiveMissionDescriptorSchema,
  ActiveMissionSelectionSchema,
  HarnessSchema,
  MISSION_EVENT_FEED_CURSOR_MAX,
  MISSION_EVENT_FEED_RETENTION_MAX,
  MISSION_EVENT_FEED_SCHEMA_VERSION,
  MISSION_EVENT_FEED_SNAPSHOT_MAX,
  MissionEventCursorExpiredSchema,
  MissionEventCursorInvalidSchema,
  MissionEventMissionReplacedSchema,
  MissionEventSnapshotSchema,
  MissionEventTailEventLineSchema,
  MissionEventTailRecoveryLineSchema,
  MissionFeedEventSchema,
  MissionPlanSchema,
  TaskKindSchema,
  WorkerResultSchema,
  isMissionEventStream,
  type ActiveMissionDescriptor,
  type ActiveMissionSelection,
  type DomainEvent,
  type MissionEventRecovery,
  type MissionEventSnapshot,
  type MissionEventTailLine,
  type MissionFeedEvent,
  type TaskKind,
} from "@clankie/protocol";
import { z } from "zod";

const CURSOR_DOMAIN = "clankie.mission-event-feed.cursor.v1\0";

const CursorPayloadSchema = z
  .object({
    schemaVersion: z.literal(MISSION_EVENT_FEED_SCHEMA_VERSION),
    missionId: z.string().trim().min(1).max(512),
    generation: z.string().trim().min(1).max(512),
    afterSourceSequence: z.number().int().nonnegative(),
  })
  .strict();

interface MissionBuffer {
  descriptor?: ActiveMissionDescriptor;
  floorSequence: number;
  records: MissionFeedEvent[];
  snapshotRecords: MissionFeedEvent[];
  snapshotOmittedEventCount: number;
  taskKinds: Map<string, TaskKind>;
}

export type MissionEventFeedSnapshotRead = MissionEventSnapshot | MissionEventRecovery;
export type MissionEventFeedTailRead =
  | { outcome: "tail"; stream: AsyncIterable<MissionEventTailLine> }
  | MissionEventRecovery;

export interface MissionEventFeedOptions {
  readonly cursorKey: Uint8Array;
  /** Read the complete canonical log from the durable event-store authority. */
  readonly readCanonicalEvents: () => Promise<readonly StoredEvent[]>;
  readonly initialEvents?: readonly StoredEvent[];
  readonly retentionLimit?: number;
  readonly snapshotLimit?: number;
}

export class MissionEventFeedAuthorityError extends Error {
  public readonly code = "mission_event_feed_authority_failure" as const;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MissionEventFeedAuthorityError";
  }
}

/**
 * Bounded read projection over canonical event-store envelopes.
 *
 * The projection never accepts caller-authored events and never copies an
 * arbitrary DomainEvent.data object. Each visible variant is reconstructed
 * through the strict public schema, keeping the internal event store as the
 * authority while making private/provider payload fields unrepresentable.
 */
export class MissionEventFeed {
  private readonly cursorKey: Uint8Array;
  private readonly readCanonicalEvents: () => Promise<readonly StoredEvent[]>;
  private readonly retentionLimit: number;
  private readonly snapshotLimit: number;
  private readonly buffers = new Map<string, MissionBuffer>();
  private readonly publishedEventIds = new Map<string, { sequence: number; hash: string }>();
  private readonly queuedEvents = new Map<number, StoredEvent>();
  private readonly queuedEventIds = new Map<string, { sequence: number; hash: string }>();
  private readonly listeners = new Set<() => void>();
  private activeMission: ActiveMissionDescriptor | undefined;
  private activeStartedSequence = 0;
  private latestSourceSequence = 0;
  private latestSourceHash = GENESIS_HASH;
  private revision = 0;
  private reconciliation: Promise<void> = Promise.resolve();

  public constructor(options: MissionEventFeedOptions) {
    if (options.cursorKey.byteLength < 32)
      throw new Error("mission event cursor key must be at least 32 bytes");
    this.cursorKey = Uint8Array.from(options.cursorKey);
    this.readCanonicalEvents = options.readCanonicalEvents;
    this.retentionLimit = boundedLimit(
      options.retentionLimit ?? MISSION_EVENT_FEED_RETENTION_MAX,
      MISSION_EVENT_FEED_RETENTION_MAX,
      "retention",
    );
    this.snapshotLimit = boundedLimit(
      options.snapshotLimit ?? MISSION_EVENT_FEED_SNAPSHOT_MAX,
      MISSION_EVENT_FEED_SNAPSHOT_MAX,
      "snapshot",
    );
    this.applyAuthoritativeRead(options.initialEvents ?? [], false);
  }

  public async selection(): Promise<ActiveMissionSelection> {
    await this.reconcile();
    return ActiveMissionSelectionSchema.parse({
      schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
      activeMission: this.activeMission ?? null,
    });
  }

  public async snapshot(missionId: string): Promise<MissionEventFeedSnapshotRead> {
    await this.reconcile();
    const replacement = this.replacementFor(missionId);
    if (replacement) return replacement;
    const buffer = this.buffers.get(missionId);
    const mission = buffer?.descriptor;
    if (!buffer || !mission) return this.replacementFor(missionId, true)!;

    const records = buffer.snapshotRecords;
    const latest = buffer.records.at(-1)?.sourceSequence ?? buffer.floorSequence;
    return MissionEventSnapshotSchema.parse({
      schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
      outcome: "snapshot",
      mission,
      replayAfterSourceSequenceFloor: buffer.floorSequence,
      resumeAfterSourceSequence: latest,
      nextCursor: this.cursor(mission, latest),
      compacted: buffer.snapshotOmittedEventCount > 0,
      omittedEventCount: buffer.snapshotOmittedEventCount,
      events: records,
    });
  }

  public async openTail(
    missionId: string,
    cursor: string,
    signal: AbortSignal,
  ): Promise<MissionEventFeedTailRead> {
    await this.reconcile();
    const replacement = this.replacementFor(missionId);
    if (replacement) return replacement;
    const buffer = this.buffers.get(missionId);
    const mission = buffer?.descriptor;
    if (!buffer || !mission) return this.replacementFor(missionId, true)!;

    const parsed = this.parseCursor(cursor);
    if (!parsed || parsed.missionId !== missionId || parsed.generation !== mission.generation) {
      return MissionEventCursorInvalidSchema.parse({
        schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
        outcome: "cursor_invalid",
        missionId,
      });
    }
    const latest = buffer.records.at(-1)?.sourceSequence ?? buffer.floorSequence;
    if (parsed.afterSourceSequence < buffer.floorSequence) {
      return this.cursorExpired(mission, buffer, latest);
    }
    if (
      parsed.afterSourceSequence > latest ||
      (parsed.afterSourceSequence !== buffer.floorSequence &&
        parsed.afterSourceSequence !== 0 &&
        !buffer.records.some((event) => event.sourceSequence === parsed.afterSourceSequence))
    ) {
      return MissionEventCursorInvalidSchema.parse({
        schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
        outcome: "cursor_invalid",
        missionId,
      });
    }

    return {
      outcome: "tail",
      stream: this.tail(mission, parsed.afterSourceSequence, signal),
    };
  }

  /**
   * Offer a store-returned append as a low-latency publication hint. Gaps are
   * resolved only by rereading the canonical store; exact retries are
   * idempotent and never invent a skipped sequence.
   */
  public publish(stored: StoredEvent): Promise<void> {
    return this.serialize(async () => {
      this.acceptCanonical(stored, true);
      if (this.queuedEvents.size > 0) await this.reconcileUnlocked(true);
    });
  }

  /** Reconcile all unseen global sequences from the durable authority. */
  public reconcile(): Promise<void> {
    return this.serialize(() => this.reconcileUnlocked(true));
  }

  private acceptCanonical(stored: StoredEvent, notify: boolean): void {
    this.assertEnvelope(stored);
    const previous = this.publishedEventIds.get(stored.event.id) ?? this.queuedEventIds.get(stored.event.id);
    if (previous !== undefined) {
      if (previous.sequence !== stored.sequence || previous.hash !== stored.hash) {
        throw new MissionEventFeedAuthorityError("mission event id was rebound to another envelope");
      }
      return;
    }
    if (stored.sequence <= this.latestSourceSequence) {
      throw new MissionEventFeedAuthorityError(
        "mission event sequence conflicts with the already reconciled canonical log",
      );
    }
    const queued = this.queuedEvents.get(stored.sequence);
    if (queued) {
      if (queued.event.id !== stored.event.id || queued.hash !== stored.hash) {
        throw new MissionEventFeedAuthorityError("mission event sequence was assigned to another envelope");
      }
      return;
    }
    this.queuedEvents.set(stored.sequence, stored);
    this.queuedEventIds.set(stored.event.id, { sequence: stored.sequence, hash: stored.hash });
    let next = this.queuedEvents.get(this.latestSourceSequence + 1);
    while (next) {
      if (next.previousHash !== this.latestSourceHash) {
        throw new MissionEventFeedAuthorityError(
          `mission event hash link failed at sequence ${String(next.sequence)}`,
        );
      }
      this.queuedEvents.delete(next.sequence);
      this.queuedEventIds.delete(next.event.id);
      this.applyCanonical(next, notify);
      next = this.queuedEvents.get(this.latestSourceSequence + 1);
    }
  }

  private async reconcileUnlocked(notify: boolean): Promise<void> {
    let entries: readonly StoredEvent[];
    try {
      entries = await this.readCanonicalEvents();
    } catch (error) {
      throw new MissionEventFeedAuthorityError("mission event authority could not be read", {
        cause: error,
      });
    }
    this.applyAuthoritativeRead(entries, notify);
  }

  private applyAuthoritativeRead(entries: readonly StoredEvent[], notify: boolean): void {
    let verification;
    try {
      verification = verifyChain(entries);
    } catch (error) {
      throw new MissionEventFeedAuthorityError("mission event authority contains an unreadable envelope", {
        cause: error,
      });
    }
    if (!verification.valid) {
      throw new MissionEventFeedAuthorityError(
        verification.error ?? "mission event authority failed hash-chain verification",
      );
    }
    if (entries.length < this.latestSourceSequence) {
      throw new MissionEventFeedAuthorityError(
        `mission event authority regressed from sequence ${String(this.latestSourceSequence)} to ${String(entries.length)}`,
      );
    }
    for (const queued of this.queuedEvents.values()) {
      const authoritative = entries[queued.sequence - 1];
      if (
        authoritative === undefined ||
        authoritative.event.id !== queued.event.id ||
        authoritative.hash !== queued.hash
      ) {
        throw new MissionEventFeedAuthorityError(
          `mission event publication hint conflicts with authority at sequence ${String(queued.sequence)}`,
        );
      }
    }
    for (const stored of entries) this.acceptCanonical(stored, notify);
    if (this.latestSourceSequence !== entries.length || this.queuedEvents.size > 0) {
      throw new MissionEventFeedAuthorityError(
        `mission event authority has an unresolved gap after sequence ${String(this.latestSourceSequence)}`,
      );
    }
  }

  private assertEnvelope(stored: StoredEvent): void {
    if (!Number.isSafeInteger(stored.sequence) || stored.sequence < 1) {
      throw new MissionEventFeedAuthorityError("mission event sequence must be a positive safe integer");
    }
    let expected: StoredEvent;
    try {
      expected = seal(stored.event, stored.sequence, stored.previousHash);
    } catch (error) {
      throw new MissionEventFeedAuthorityError("mission event envelope contains an unreadable event", {
        cause: error,
      });
    }
    if (expected.hash !== stored.hash) {
      throw new MissionEventFeedAuthorityError(
        `mission event envelope hash failed at sequence ${String(stored.sequence)}`,
      );
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.reconciliation.then(operation, operation);
    this.reconciliation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private applyCanonical(stored: StoredEvent, notify: boolean): void {
    this.latestSourceSequence = stored.sequence;
    this.latestSourceHash = stored.hash;
    this.publishedEventIds.set(stored.event.id, { sequence: stored.sequence, hash: stored.hash });

    // Reserved streams (presence sessions, devices, triggers) share the log but
    // are not missions. They project to nothing, so buffering them only leaked a
    // permanent empty buffer per stream id.
    if (!isMissionEventStream(stored.event)) return;

    const buffer = this.buffer(stored.event.missionId);
    this.captureTaskKinds(buffer, stored.event);
    if (stored.event.type === "mission.execution.started") {
      const descriptor = ActiveMissionDescriptorSchema.safeParse({
        schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
        missionId: stored.event.missionId,
        generation: stored.event.id,
        startedAt: stored.event.occurredAt,
        profileHash: stored.event.profileHash,
      });
      if (descriptor.success) {
        if (buffer.descriptor?.generation !== descriptor.data.generation) {
          buffer.descriptor = descriptor.data;
          buffer.floorSequence = 0;
          buffer.records = [];
          buffer.snapshotRecords = [];
          buffer.snapshotOmittedEventCount = 0;
        }
        if (stored.sequence >= this.activeStartedSequence) {
          this.activeMission = descriptor.data;
          this.activeStartedSequence = stored.sequence;
        }
      }
    }

    const previousVisibleSequence = buffer.records.at(-1)?.sourceSequence ?? buffer.floorSequence;
    const projected = projectPublicEvent(stored, previousVisibleSequence, buffer.taskKinds);
    if (projected) {
      buffer.records.push(projected);
      buffer.snapshotRecords.push(projected);
      if (buffer.snapshotRecords.length > this.snapshotLimit) {
        const before = buffer.snapshotRecords.length;
        buffer.snapshotRecords = compactSnapshot(buffer.snapshotRecords, this.snapshotLimit);
        buffer.snapshotOmittedEventCount += before - buffer.snapshotRecords.length;
      }
      while (buffer.records.length > this.retentionLimit) {
        const removed = buffer.records.shift();
        if (removed) buffer.floorSequence = removed.sourceSequence;
      }
    }
    if (projected || stored.event.type === "mission.execution.started") {
      this.revision += 1;
      if (notify) this.notify();
    }
  }

  private async *tail(
    mission: ActiveMissionDescriptor,
    initialSequence: number,
    signal: AbortSignal,
  ): AsyncIterable<MissionEventTailLine> {
    let afterSequence = initialSequence;
    while (!signal.aborted) {
      const replacement = this.replacementFor(mission.missionId);
      if (replacement || this.activeMission?.generation !== mission.generation) {
        yield MissionEventTailRecoveryLineSchema.parse({
          schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
          type: "mission_event.recovery",
          recovery: replacement ?? this.replacementFor(mission.missionId, true),
        });
        return;
      }
      const buffer = this.buffers.get(mission.missionId);
      if (!buffer) return;
      const latest = buffer.records.at(-1)?.sourceSequence ?? buffer.floorSequence;
      if (afterSequence < buffer.floorSequence) {
        yield MissionEventTailRecoveryLineSchema.parse({
          schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
          type: "mission_event.recovery",
          recovery: this.cursorExpired(mission, buffer, latest),
        });
        return;
      }
      const available = buffer.records.filter((event) => event.sourceSequence > afterSequence);
      if (available.length > 0) {
        for (const event of available) {
          if (signal.aborted) return;
          afterSequence = event.sourceSequence;
          yield MissionEventTailEventLineSchema.parse({
            schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
            type: "mission_event.event",
            event,
            cursor: this.cursor(mission, afterSequence),
          });
        }
        continue;
      }
      const observedRevision = this.revision;
      await this.waitForChange(observedRevision, signal);
    }
  }

  private replacementFor(missionId: string, force = false): MissionEventRecovery | undefined {
    if (!force && this.activeMission?.missionId === missionId) return undefined;
    return MissionEventMissionReplacedSchema.parse({
      schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
      outcome: "mission_replaced",
      requestedMissionId: missionId,
      replacementMission: this.activeMission ?? null,
    });
  }

  private cursorExpired(
    mission: ActiveMissionDescriptor,
    buffer: MissionBuffer,
    latest: number,
  ): MissionEventRecovery {
    return MissionEventCursorExpiredSchema.parse({
      schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
      outcome: "cursor_expired",
      mission,
      replayAfterSourceSequenceFloor: buffer.floorSequence,
      snapshotCursor: this.cursor(mission, latest),
    });
  }

  private buffer(missionId: string): MissionBuffer {
    const existing = this.buffers.get(missionId);
    if (existing) return existing;
    const created: MissionBuffer = {
      floorSequence: 0,
      records: [],
      snapshotRecords: [],
      snapshotOmittedEventCount: 0,
      taskKinds: new Map(),
    };
    this.buffers.set(missionId, created);
    return created;
  }

  private captureTaskKinds(buffer: MissionBuffer, event: DomainEvent): void {
    if (event.type !== "mission.planned") return;
    const plan = MissionPlanSchema.safeParse(event.data.plan);
    if (!plan.success) return;
    for (const task of plan.data.tasks) buffer.taskKinds.set(task.id, task.kind);
  }

  private cursor(mission: ActiveMissionDescriptor, afterSourceSequence: number): string {
    const payload = Buffer.from(
      JSON.stringify({
        schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
        missionId: mission.missionId,
        generation: mission.generation,
        afterSourceSequence,
      }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", this.cursorKey)
      .update(CURSOR_DOMAIN)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private parseCursor(cursor: string): z.infer<typeof CursorPayloadSchema> | undefined {
    if (!cursor || cursor.length > MISSION_EVENT_FEED_CURSOR_MAX) return undefined;
    const parts = cursor.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
    try {
      const payloadBytes = Buffer.from(parts[0], "base64url");
      if (payloadBytes.toString("base64url") !== parts[0]) return undefined;
      const actual = Buffer.from(parts[1], "base64url");
      if (actual.toString("base64url") !== parts[1]) return undefined;
      const expected = createHmac("sha256", this.cursorKey).update(CURSOR_DOMAIN).update(parts[0]).digest();
      if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return undefined;
      return CursorPayloadSchema.parse(JSON.parse(payloadBytes.toString("utf8")));
    } catch {
      return undefined;
    }
  }

  private waitForChange(observedRevision: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.revision !== observedRevision) return Promise.resolve();
    return new Promise((resolve) => {
      const settle = () => {
        this.listeners.delete(settle);
        signal.removeEventListener("abort", settle);
        resolve();
      };
      this.listeners.add(settle);
      signal.addEventListener("abort", settle, { once: true });
      if (this.revision !== observedRevision) settle();
    });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function boundedLimit(value: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`mission event ${label} limit must be between 1 and ${String(maximum)}`);
  }
  return value;
}

function compactSnapshot(events: readonly MissionFeedEvent[], limit: number): MissionFeedEvent[] {
  if (events.length <= limit) return [...events];
  const selected = new Set<number>();
  const firstIdentity = new Map<string, number>();
  const latestByWorker = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (event.type === "mission.execution.started") selected.add(index);
    if (event.workerRunId) {
      latestByWorker.set(event.workerRunId, index);
      if (
        (event.type === "worker.started" || event.type === "worker.leased") &&
        !firstIdentity.has(event.workerRunId)
      ) {
        firstIdentity.set(event.workerRunId, index);
      }
    }
    if (event.type === "mission.succeeded" || event.type === "mission.failed") selected.add(index);
  }
  for (const index of firstIdentity.values()) selected.add(index);
  for (const index of latestByWorker.values()) selected.add(index);
  for (let index = events.length - 1; index >= 0 && selected.size < limit; index -= 1) selected.add(index);
  const indices = [...selected].sort((left, right) => left - right);
  const bounded = indices.length <= limit ? indices : indices.slice(indices.length - limit);
  return bounded
    .map((index) => events[index])
    .filter((event): event is MissionFeedEvent => event !== undefined);
}

function projectPublicEvent(
  stored: StoredEvent,
  previousSourceSequence: number,
  taskKinds: ReadonlyMap<string, TaskKind>,
): MissionFeedEvent | undefined {
  const { event } = stored;
  const base = {
    schemaVersion: MISSION_EVENT_FEED_SCHEMA_VERSION,
    eventId: event.id,
    sourceSequence: stored.sequence,
    previousSourceSequence,
    occurredAt: event.occurredAt,
    missionId: event.missionId,
    correlationId: event.correlationId,
    profileHash: event.profileHash,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.workerRunId ? { workerRunId: event.workerRunId } : {}),
    ...(event.causationId ? { causationId: event.causationId } : {}),
  };
  let candidate: unknown;
  if (event.type === "mission.execution.started") {
    candidate = { ...base, type: event.type, data: {} };
  } else if (event.type === "worker.started" && event.taskId && event.workerRunId) {
    const identity = workerIdentity(event.data, taskKinds.get(event.taskId));
    if (identity) candidate = { ...base, type: event.type, data: identity };
  } else if (event.type === "worker.leased" && event.taskId && event.workerRunId) {
    const worker = z.object({ id: z.string(), harness: HarnessSchema }).safeParse(event.data.worker);
    const attempt = z.number().int().positive().safeParse(event.data.attempt);
    const taskKind = taskKinds.get(event.taskId);
    if (worker.success && attempt.success && taskKind) {
      candidate = {
        ...base,
        type: event.type,
        data: { workerId: worker.data.id, harness: worker.data.harness, taskKind, attempt: attempt.data },
      };
    }
  } else if (event.type === "worker.turn.started" && event.taskId && event.workerRunId) {
    candidate = { ...base, type: event.type, data: { state: "working" } };
  } else if (event.type === "worker.turn.settled" && event.taskId && event.workerRunId) {
    candidate = { ...base, type: event.type, data: { state: "idle" } };
  } else if (event.type === "worker.waiting_user" && event.taskId && event.workerRunId) {
    candidate = { ...base, type: event.type, data: { summary: "User input required" } };
  } else if (
    (event.type === "worker.waiting_dependency" || event.type === "task.waiting_dependency") &&
    event.taskId &&
    event.workerRunId
  ) {
    candidate = { ...base, type: event.type, data: { summary: "Waiting for a dependency" } };
  } else if (event.type === "worker.progress" && event.taskId && event.workerRunId) {
    candidate = { ...base, type: event.type, data: { summary: "Working" } };
  } else if (event.type === "worker.status.resolved" && event.taskId && event.workerRunId) {
    const status = z
      .object({
        state: z.enum([
          "unknown",
          "working",
          "idle",
          "waiting_dependency",
          "waiting_user",
          "blocked",
          "failed",
          "completed",
          "offline",
        ]),
        tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
        confidence: z.number().min(0).max(1),
        observedAt: z.string().datetime(),
        attentionRaised: z.boolean(),
      })
      .safeParse(event.data);
    if (status.success) candidate = { ...base, type: event.type, data: status.data };
  } else if (
    (event.type === "task.failed" || event.type === "worker.crashed") &&
    event.taskId &&
    event.workerRunId
  ) {
    candidate = { ...base, type: event.type, data: { summary: "Task failed" } };
  } else if (event.type === "task.blocked" && event.taskId && event.workerRunId) {
    candidate = { ...base, type: event.type, data: { summary: "Task blocked" } };
  } else if (event.type === "task.succeeded" && event.taskId && event.workerRunId) {
    candidate = { ...base, type: event.type, data: { summary: "Task completed" } };
  } else if (event.type === "worker.settled" && event.taskId && event.workerRunId) {
    const result = WorkerResultSchema.safeParse(event.data.result);
    if (result.success) {
      candidate = {
        ...base,
        type: event.type,
        data: {
          result: result.data.status,
          artifactIds: result.data.evidence
            .map((evidence) => evidence.uri)
            .filter(isArtifactId)
            .slice(0, 100),
        },
      };
    }
  } else if (event.type === "worker.completed" && event.taskId && event.workerRunId) {
    const result = z.enum(["succeeded", "failed", "blocked"]).safeParse(event.data.result);
    if (result.success) candidate = { ...base, type: event.type, data: { result: result.data } };
  } else if (event.type === "mission.succeeded") {
    candidate = { ...base, type: event.type, data: { summary: "Mission completed" } };
  } else if (event.type === "mission.failed") {
    candidate = { ...base, type: event.type, data: { summary: "Mission failed" } };
  }
  const parsed = MissionFeedEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function workerIdentity(data: Record<string, unknown>, fallbackTaskKind?: TaskKind) {
  const parsed = z
    .object({
      workerId: z.string(),
      harness: HarnessSchema,
      taskKind: TaskKindSchema.optional(),
      attempt: z.number().int().positive(),
    })
    .safeParse(data);
  const taskKind = parsed.success ? (parsed.data.taskKind ?? fallbackTaskKind) : undefined;
  if (!parsed.success || !taskKind) return undefined;
  return {
    workerId: parsed.data.workerId,
    harness: parsed.data.harness,
    taskKind,
    attempt: parsed.data.attempt,
  };
}

function isArtifactId(value: string | undefined): value is string {
  return value !== undefined && /^artifact:\/\/[A-Za-z0-9._~:/-]{1,1000}$/u.test(value);
}
