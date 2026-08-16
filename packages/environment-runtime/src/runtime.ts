import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  EnvironmentSemanticEventSchema,
  EnvironmentStartActionCommandSchema,
  EnvironmentTelemetryReferenceSchema,
  normalizeEnvironmentLease,
  normalizeEnvironmentSessionSpec,
  type EnvironmentActionResult,
  type EnvironmentCommand,
  type EnvironmentEvent,
  type EnvironmentLeaseV2,
  type EnvironmentSemanticEventType,
  type EnvironmentSessionPhase,
  type EnvironmentSessionSpec,
  type EnvironmentSessionSpecV2,
  type EnvironmentTelemetryReference,
} from "@clankie/interactive-environment";

export const MAX_ENVIRONMENT_LEASE_MS = 5 * 60_000;
const EMERGENCY_ADAPTER_TIMEOUT_MS = 1_000;
export type EnvironmentStartActionCommand = Extract<EnvironmentCommand, { type: "start_action" }>;

export interface EnvironmentAdapterActionCompletion {
  status: "completed";
  outcome: Record<string, unknown>;
}

export interface EnvironmentAdapterActionRunning {
  status: "running";
  /**
   * Adapter-owned work settles out of band so the runtime queue remains
   * available for pause, cancel, lease expiry, and emergency fencing.
   */
  completion: Promise<EnvironmentAdapterActionCompletion>;
}

/**
 * The holder's claim lapsed while the body kept its state. Typed so a caller
 * can tell this recoverable condition apart from a revocation, which is final:
 * `renew` re-acquires a lapsed lease, nothing re-acquires a revoked one.
 */
export class EnvironmentLeaseExpiredError extends Error {
  public constructor() {
    super("Environment lease is expired");
    this.name = "EnvironmentLeaseExpiredError";
  }
}

export class EnvironmentAdapterActionError extends Error {
  public readonly errorCode: string;
  public readonly retryable: boolean;

  public constructor(errorCode: string, message: string, retryable = false) {
    super(message);
    this.name = "EnvironmentAdapterActionError";
    this.errorCode = errorCode;
    this.retryable = retryable;
  }
}

export interface EnvironmentAdapterSession {
  readonly adapterSessionId: string;
  pause(reason: string): Promise<void>;
  resume(): Promise<void>;
  startAction(
    command: EnvironmentStartActionCommand,
  ): Promise<EnvironmentAdapterActionCompletion | EnvironmentAdapterActionRunning | void>;
  cancelAction(actionId: string, reason: string): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface EnvironmentAdapter {
  start(
    spec: EnvironmentSessionSpecV2,
    connection: Readonly<Record<string, string>>,
  ): Promise<EnvironmentAdapterSession>;
  attach(
    spec: EnvironmentSessionSpecV2,
    adapterSessionId: string,
  ): Promise<EnvironmentAdapterSession | undefined>;
}

export interface EnvironmentEventSink {
  append(event: EnvironmentEvent): Promise<void>;
}

export interface StartEnvironmentInput {
  spec: EnvironmentSessionSpec;
  holderId: string;
  correlationId: string;
  leaseDurationMs?: number;
  missionId?: string;
  taskId?: string;
  /** Runner-private connection material. Never persisted or emitted. */
  connection?: Readonly<Record<string, string>>;
}

export interface EnvironmentSessionSnapshot {
  spec: EnvironmentSessionSpecV2;
  lease: EnvironmentLeaseV2;
  phase: EnvironmentSessionPhase;
  actions: Record<string, EnvironmentActionResult>;
}

export interface EnvironmentSessionGrant {
  /** Runner-private bearer. Never include this object in model context or logs. */
  token: string;
  session: EnvironmentSessionSnapshot;
}

export interface ReconcileEnvironmentReport {
  attached: string[];
  retained: string[];
  failed: string[];
  expired: string[];
}

interface StoredAction {
  result: EnvironmentActionResult;
  deadlineAt: string;
}

interface StoredSession {
  schemaVersion: 2;
  spec: EnvironmentSessionSpecV2;
  lease: EnvironmentLeaseV2;
  leaseDurationMs: number;
  tokenHash: string;
  phase: EnvironmentSessionPhase;
  adapterSessionId: string | null;
  revokedAt: string | null;
  /**
   * Set once when a lease lapse was handled, cleared by `renew`. `pausedBody`
   * remembers whether the lapse itself paused the body, so renewal resumes
   * exactly the pause it caused and never overrides a deliberate safety pause.
   */
  leaseLapse?: { at: string; pausedBody: boolean } | null;
  correlationId: string;
  actions: Record<string, StoredAction>;
  /** Terminal action records dropped under retention. Honest, never silent. */
  rolledActionRecords?: number;
}

/**
 * Bounds for open-ended sessions (ADR 0061's rolling-evidence shape applied to
 * runtime state). Unset means keep everything, which is right for the frozen
 * deterministic scenarios; a marathon free-play caller opts in so its record
 * stays a bounded working set instead of an ever-growing rewrite-on-every-action
 * file. What rolls off is counted on the record; the durable play journal, not
 * this operational state, is the full history.
 */
export interface EnvironmentRuntimeRetention {
  /** Most recent action records kept per session; only terminal results roll. */
  maxActionRecords?: number;
  /** Ended (`off`/`failed`) session records kept on disk; older ones are removed. */
  maxEndedSessionRecords?: number;
}

export interface EnvironmentRuntimeOptions {
  rootDir: string;
  adapter: EnvironmentAdapter;
  events: EnvironmentEventSink;
  clock?: () => Date;
  randomToken?: () => string;
  retention?: EnvironmentRuntimeRetention;
}

/** Durable, single-writer environment lifecycle owned by the trusted runner. */
export class EnvironmentRuntime {
  private readonly rootDir: string;
  private readonly adapter: EnvironmentAdapter;
  private readonly events: EnvironmentEventSink;
  private readonly clock: () => Date;
  private readonly randomToken: () => string;
  private readonly retention: EnvironmentRuntimeRetention | undefined;
  private readonly records = new Map<string, StoredSession>();
  private readonly attached = new Map<string, EnvironmentAdapterSession>();
  private readonly secrets = new Map<string, Set<string>>();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: EnvironmentRuntimeOptions) {
    this.rootDir = resolve(options.rootDir);
    this.adapter = options.adapter;
    this.events = options.events;
    this.clock = options.clock ?? (() => new Date());
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.retention = options.retention;
  }

  public start(input: StartEnvironmentInput): Promise<EnvironmentSessionGrant> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      await this.sweepRecords();
      const spec = normalizeEnvironmentSessionSpec(input.spec);
      const leaseDurationMs = input.leaseDurationMs ?? 30_000;
      if (
        !Number.isInteger(leaseDurationMs) ||
        leaseDurationMs <= 0 ||
        leaseDurationMs > MAX_ENVIRONMENT_LEASE_MS
      ) {
        throw new Error(`Environment lease duration must be 1-${String(MAX_ENVIRONMENT_LEASE_MS)}ms`);
      }
      const conflict = this.writerConflict(spec.characterId, spec.worldId, null);
      if (conflict) throw new Error(`Body already has writer session ${conflict.spec.sessionId}`);

      const token = this.randomToken();
      const sensitive = new Set([token, ...Object.values(input.connection ?? {})]);
      const now = this.clock();
      const record: StoredSession = {
        schemaVersion: 2,
        spec,
        lease: {
          schemaVersion: 2,
          leaseId: randomUUID(),
          sessionId: spec.sessionId,
          holderId: input.holderId,
          ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          issuedAt: now.toISOString(),
          heartbeatAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
          resourceBounds: spec.resourceBounds,
        },
        leaseDurationMs,
        tokenHash: hash(token),
        phase: "starting",
        adapterSessionId: null,
        revokedAt: null,
        leaseLapse: null,
        correlationId: sanitize(input.correlationId, sensitive) as string,
        actions: {},
      };
      this.records.set(spec.sessionId, record);
      this.secrets.set(spec.sessionId, sensitive);
      await this.persist(record);
      try {
        const session = await this.adapter.start(spec, input.connection ?? {});
        record.adapterSessionId = session.adapterSessionId;
        record.phase = "active";
        this.attached.set(spec.sessionId, session);
        await this.persist(record);
        await this.emit("environment.session.started", record, input.correlationId, {
          characterId: spec.characterId,
          worldId: spec.worldId,
        });
      } catch {
        await this.fail(record, "adapter_start_failed");
        throw new Error(`Environment adapter failed to start session ${spec.sessionId}`);
      }
      return { token, session: snapshot(record) };
    });
  }

  public heartbeat(token: string, sessionId: string): Promise<EnvironmentSessionSnapshot> {
    // Every authorized call renews the lease, so a heartbeat is just an
    // authorized call with nothing else to do.
    return this.enqueue(async () => snapshot(await this.authorize(token, sessionId)));
  }

  /**
   * Re-acquire a lapsed lease on a live session. Lease expiry is a statement
   * about the holder — it went idle — not about the world, so the body was
   * paused rather than destroyed and this is the sanctioned way back in. The
   * claim is subject to the same one-writer rule as `start`, and a revoked
   * session (explicit stop, emergency stop, adapter failure) stays dead.
   */
  public renew(token: string, sessionId: string): Promise<EnvironmentSessionSnapshot> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const record = this.record(sessionId);
      if (record.tokenHash !== hash(token)) throw new Error("Environment capability rejected");
      this.secretSet(sessionId).add(token);
      if (record.revokedAt !== null || !ownsBody(record)) throw new Error(`Environment lease is revoked`);
      const conflict = this.writerConflict(record.spec.characterId, record.spec.worldId, record);
      if (conflict) throw new Error(`Body already has writer session ${conflict.spec.sessionId}`);
      if (!this.attached.has(sessionId)) await this.attachRecord(record);
      if (record.revokedAt !== null || !ownsBody(record)) throw new Error(`Environment lease is revoked`);
      const now = this.clock();
      record.lease.heartbeatAt = now.toISOString();
      record.lease.expiresAt = new Date(now.getTime() + record.leaseDurationMs).toISOString();
      if (record.leaseLapse?.pausedBody === true && record.phase === "paused") {
        await this.session(sessionId).resume();
        record.phase = "active";
      }
      record.leaseLapse = null;
      await this.persist(record);
      await this.emit("environment.session.lease_renewed", record, record.correlationId, {
        holderId: record.lease.holderId,
      });
      return snapshot(record);
    });
  }

  public pause(token: string, sessionId: string, reason: string): Promise<EnvironmentSessionSnapshot> {
    return this.enqueue(async () => {
      const record = await this.authorize(token, sessionId);
      if (record.phase === "paused") return snapshot(record);
      if (record.phase !== "active")
        throw new Error(`Session ${sessionId} cannot pause from ${record.phase}`);
      const safe = this.safeText(record, `paused: ${safeReason(reason)}`);
      await this.cancelAll(record, safe);
      await this.session(sessionId).pause(safe);
      record.phase = "paused";
      await this.persist(record);
      return snapshot(record);
    });
  }

  public resume(token: string, sessionId: string): Promise<EnvironmentSessionSnapshot> {
    return this.enqueue(async () => {
      const record = await this.authorize(token, sessionId);
      if (record.phase === "active") return snapshot(record);
      if (record.phase !== "paused")
        throw new Error(`Session ${sessionId} cannot resume from ${record.phase}`);
      await this.session(sessionId).resume();
      record.phase = "active";
      await this.persist(record);
      return snapshot(record);
    });
  }

  public startAction(token: string, raw: EnvironmentStartActionCommand): Promise<EnvironmentActionResult> {
    const parsedCommand = EnvironmentStartActionCommandSchema.parse(raw);
    return this.enqueue(async () => {
      const record = await this.authorize(token, parsedCommand.sessionId);
      const command = parsedCommand;
      const prior = record.actions[command.actionId];
      if (prior) return structuredClone(prior.result);
      // Deadlines are enforced wherever a dispatch touches the session, not
      // only by the sweep at start: an in-flight action whose completion never
      // settles (a wait nobody finishes, a hung adapter) would otherwise wedge
      // the body permanently — the adapter fails closed with
      // `action_already_pending` on every turn until the process dies.
      await this.cancelTimedOutActions(record);
      if (record.phase !== "active") throw new Error(`Session ${command.sessionId} is not active`);
      if (command.context.expectedGoalVersion !== record.spec.initialGoalVersion) {
        return {
          schemaVersion: 1,
          actionId: command.actionId,
          sessionId: command.sessionId,
          status: "stale",
          expectedGoalVersion: command.context.expectedGoalVersion,
          currentGoalVersion: record.spec.initialGoalVersion,
          updatedAt: this.clock().toISOString(),
        };
      }
      const queued: EnvironmentActionResult = {
        schemaVersion: 1,
        actionId: command.actionId,
        sessionId: command.sessionId,
        status: "queued",
        acceptedGoalVersion: record.spec.initialGoalVersion,
        updatedAt: this.clock().toISOString(),
      };
      record.actions[command.actionId] = {
        result: queued,
        deadlineAt: new Date(
          this.clock().getTime() + record.lease.resourceBounds.maxActionDurationMs,
        ).toISOString(),
      };
      this.rollActions(record);
      await this.persist(record); // register before dispatch: retries cannot repeat the action
      await this.emit("environment.action.requested", record, command.context.correlationId, {
        actionId: command.actionId,
        kind: command.action.kind,
      });
      try {
        const dispatch = await this.session(command.sessionId).startAction(command);
        if (record.revokedAt !== null || !ownsBody(record)) {
          // The body was fenced (e.g. emergency stop) while this dispatch was in flight; do not
          // overwrite the terminal result the fence recorded.
          return structuredClone(record.actions[command.actionId]!.result);
        }
        if (dispatch?.status === "completed") {
          const completed: EnvironmentActionResult = {
            ...queued,
            status: "completed",
            outcome: sanitize(dispatch.outcome, this.secretSet(command.sessionId)) as Record<string, unknown>,
            updatedAt: this.clock().toISOString(),
          };
          record.actions[command.actionId]!.result = completed;
          await this.persist(record);
          await this.emit("environment.action.completed", record, command.context.correlationId, {
            actionId: command.actionId,
          });
          return completed;
        }
        if (dispatch?.status === "running") {
          this.watchAdapterCompletion(
            record,
            command.actionId,
            command.context.correlationId,
            dispatch.completion,
          );
        }
        const running: EnvironmentActionResult = {
          ...queued,
          status: "running",
          updatedAt: this.clock().toISOString(),
        };
        record.actions[command.actionId]!.result = running;
        await this.persist(record);
        await this.emit("environment.action.started", record, command.context.correlationId, {
          actionId: command.actionId,
        });
        return running;
      } catch (error) {
        const adapterError =
          error instanceof EnvironmentAdapterActionError
            ? error
            : new EnvironmentAdapterActionError(
                "adapter_error",
                "Environment adapter rejected the action",
                true,
              );
        const failed: EnvironmentActionResult = {
          schemaVersion: 1,
          actionId: command.actionId,
          sessionId: command.sessionId,
          status: "failed",
          acceptedGoalVersion: record.spec.initialGoalVersion,
          errorCode: adapterError.errorCode,
          message: this.safeText(record, adapterError.message),
          retryable: adapterError.retryable,
          updatedAt: this.clock().toISOString(),
        };
        record.actions[command.actionId]!.result = failed;
        await this.persist(record);
        await this.emit("environment.action.failed", record, command.context.correlationId, {
          actionId: command.actionId,
          errorCode: adapterError.errorCode,
        });
        return failed;
      }
    });
  }

  private watchAdapterCompletion(
    record: StoredSession,
    actionId: string,
    correlationId: string,
    completion: Promise<EnvironmentAdapterActionCompletion>,
  ): void {
    void completion.then(
      (result) =>
        this.enqueue(async () => {
          const current = record.actions[actionId];
          if (!current || terminal(current.result) || record.revokedAt !== null || !ownsBody(record)) return;
          current.result = {
            schemaVersion: 1,
            actionId,
            sessionId: record.spec.sessionId,
            status: "completed",
            acceptedGoalVersion: record.spec.initialGoalVersion,
            outcome: sanitize(result.outcome, this.secretSet(record.spec.sessionId)) as Record<
              string,
              unknown
            >,
            updatedAt: this.clock().toISOString(),
          };
          await this.persist(record);
          await this.emit("environment.action.completed", record, correlationId, { actionId });
        }),
      (error: unknown) =>
        this.enqueue(async () => {
          const current = record.actions[actionId];
          if (!current || terminal(current.result) || record.revokedAt !== null || !ownsBody(record)) return;
          const adapterError =
            error instanceof EnvironmentAdapterActionError
              ? error
              : new EnvironmentAdapterActionError("adapter_error", "Environment adapter action failed", true);
          current.result = {
            schemaVersion: 1,
            actionId,
            sessionId: record.spec.sessionId,
            status: "failed",
            acceptedGoalVersion: record.spec.initialGoalVersion,
            errorCode: adapterError.errorCode,
            message: this.safeText(record, adapterError.message),
            retryable: adapterError.retryable,
            updatedAt: this.clock().toISOString(),
          };
          await this.persist(record);
          await this.emit("environment.action.failed", record, correlationId, {
            actionId,
            errorCode: adapterError.errorCode,
          });
        }),
    );
  }

  public finishAction(
    token: string,
    sessionId: string,
    actionId: string,
    outcome: Record<string, unknown>,
  ): Promise<EnvironmentActionResult> {
    return this.enqueue(async () => {
      const record = await this.authorize(token, sessionId);
      const action = mustAction(record, actionId);
      if (terminal(action.result)) return structuredClone(action.result);
      action.result = {
        schemaVersion: 1,
        actionId,
        sessionId,
        status: "completed",
        acceptedGoalVersion: record.spec.initialGoalVersion,
        outcome: sanitize(outcome, this.secretSet(sessionId)) as Record<string, unknown>,
        updatedAt: this.clock().toISOString(),
      };
      await this.persist(record);
      await this.emit("environment.action.completed", record, record.correlationId, { actionId });
      return structuredClone(action.result);
    });
  }

  public actionStatus(token: string, sessionId: string, actionId: string): Promise<EnvironmentActionResult> {
    return this.enqueue(async () =>
      structuredClone(mustAction(await this.authorize(token, sessionId), actionId).result),
    );
  }

  public cancelAction(
    token: string,
    sessionId: string,
    actionId: string,
    reason: string,
  ): Promise<EnvironmentActionResult> {
    return this.enqueue(async () => this.cancelOne(await this.authorize(token, sessionId), actionId, reason));
  }

  public stop(token: string, sessionId: string, reason: string): Promise<EnvironmentSessionSnapshot> {
    return this.enqueue(async () => {
      const record = await this.authorize(token, sessionId);
      await this.stopRecord(record, reason);
      return snapshot(record);
    });
  }

  /**
   * Trusted runner kill switch: deliberately requires no model or capability token, and runs on a
   * lane independent of the shared adapter queue so a hung adapter call cannot starve it. The
   * synchronous revoke fences the body before any await, keeping it race-safe with normal completion.
   */
  public emergencyStop(sessionId: string, reason: string): Promise<EnvironmentSessionSnapshot> {
    return this.emergencyStopNow(sessionId, safeReason(reason));
  }

  private async emergencyStopNow(sessionId: string, reason: string): Promise<EnvironmentSessionSnapshot> {
    await this.ensureLoaded();
    const record = this.record(sessionId);
    if (record.phase === "off" || record.phase === "failed") return snapshot(record);
    const safe = this.safeText(record, `emergency: ${reason}`);
    // Synchronous fence: revoke and mark live actions cancelled before any await, so a concurrent or
    // parked queue operation observes the revoke and cannot resurrect the body.
    record.revokedAt ??= this.clock().toISOString();
    record.phase = "stopping";
    const cancelledIds: string[] = [];
    for (const [actionId, action] of Object.entries(record.actions)) {
      if (!terminal(action.result)) {
        action.result = cancelled(action.result, this.clock(), safe);
        cancelledIds.push(actionId);
      }
    }
    await this.persist(record); // durable revoke before any adapter I/O
    const session = this.attached.get(sessionId);
    for (const actionId of cancelledIds) {
      await this.boundedAdapterCall(session?.cancelAction(actionId, safe));
      await this.emit("environment.action.cancelled", record, record.correlationId, {
        actionId,
        reason: safe,
      });
    }
    await this.boundedAdapterCall(session?.stop(safe));
    this.attached.delete(sessionId);
    record.phase = "off";
    await this.persist(record);
    await this.emit("environment.session.stopped", record, record.correlationId, { reason: safe });
    return snapshot(record);
  }

  /** Best-effort adapter teardown that cannot be starved by a hung adapter promise. */
  private async boundedAdapterCall(work: Promise<void> | undefined): Promise<void> {
    if (!work) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, EMERGENCY_ADAPTER_TIMEOUT_MS);
    });
    try {
      await Promise.race([work.catch(() => undefined), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public publishTelemetry(
    token: string,
    raw: EnvironmentTelemetryReference,
  ): Promise<EnvironmentTelemetryReference> {
    return this.enqueue(async () => {
      await this.authorize(token, raw.sessionId);
      const reference = EnvironmentTelemetryReferenceSchema.parse(raw);
      if (!reference.uri.startsWith("artifact://")) throw new Error("Telemetry requires artifact:// URI");
      const safe = EnvironmentTelemetryReferenceSchema.parse(
        sanitize(reference, this.secretSet(raw.sessionId)),
      );
      await this.events.append(safe);
      return safe;
    });
  }

  public reconcile(
    connections?: Readonly<Record<string, Readonly<Record<string, string>>>>,
  ): Promise<ReconcileEnvironmentReport> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      // Connection material is never persisted. The trusted runner re-provides it on restart so
      // value-based redaction stays durable across reconciliation without storing a recoverable secret.
      if (connections) {
        for (const [sessionId, material] of Object.entries(connections)) {
          const set = this.secretSet(sessionId);
          for (const value of Object.values(material)) if (value.length > 0) set.add(value);
        }
      }
      const report: ReconcileEnvironmentReport = {
        attached: [],
        retained: [],
        failed: [],
        expired: [],
      };
      for (const record of this.records.values()) {
        if (!ownsBody(record)) continue;
        if (this.expired(record)) {
          await this.attachRecord(record);
          await this.expireLease(record);
          report.expired.push(record.spec.sessionId);
        } else if (this.attached.has(record.spec.sessionId)) {
          report.retained.push(record.spec.sessionId);
        } else {
          await this.attachRecord(record);
          (record.phase === "failed" ? report.failed : report.attached).push(record.spec.sessionId);
        }
      }
      return report;
    });
  }

  /** Expire leases and action deadlines without relying on a model turn. */
  public sweep(): Promise<{ expiredSessions: string[]; timedOutActions: string[] }> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.sweepRecords();
    });
  }

  public list(): Promise<EnvironmentSessionSnapshot[]> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return [...this.records.values()].map(snapshot);
    });
  }

  private async authorize(token: string, sessionId: string): Promise<StoredSession> {
    await this.ensureLoaded();
    const record = this.record(sessionId);
    if (record.tokenHash !== hash(token)) throw new Error("Environment capability rejected");
    this.secretSet(sessionId).add(token);
    if (record.revokedAt !== null || !ownsBody(record)) throw new Error(`Environment lease is revoked`);
    if (this.expired(record)) {
      await this.expireLease(record);
      throw new EnvironmentLeaseExpiredError();
    }
    // Use renews the lease: acting is liveness, so an actively driven session
    // never lapses mid-play. Only an idle holder's claim expires.
    const now = this.clock();
    record.lease.heartbeatAt = now.toISOString();
    record.lease.expiresAt = new Date(now.getTime() + record.leaseDurationMs).toISOString();
    await this.persist(record);
    return record;
  }

  /**
   * Handle a lease lapse without destroying the session: cancel what was in
   * flight and pause the body, leaving it exactly where the last action put it
   * so `renew` can resume play. Idempotent — one lapse is handled once, however
   * many sweeps or rejected calls observe it. Contrast `stopRecord` and
   * `emergencyStop`, which revoke: those are decisions about the session, while
   * expiry is only the absence of the holder.
   */
  private async expireLease(record: StoredSession): Promise<void> {
    if (record.leaseLapse != null) return;
    if (!this.attached.has(record.spec.sessionId)) await this.attachRecord(record);
    // attachRecord fails the record when the adapter session is gone; a lapse
    // of a dead session has nothing to pause or keep.
    if (record.revokedAt !== null || !ownsBody(record)) return;
    const safe = this.safeText(record, "lease expired");
    await this.cancelAll(record, safe);
    const pausedBody = record.phase === "active" || record.phase === "starting";
    if (pausedBody) {
      await this.attached
        .get(record.spec.sessionId)
        ?.pause(safe)
        .catch(() => undefined);
      record.phase = "paused";
    }
    record.leaseLapse = { at: this.clock().toISOString(), pausedBody };
    await this.persist(record);
    await this.emit("environment.session.lease_expired", record, record.correlationId, {
      holderId: record.lease.holderId,
      pausedBody,
    });
  }

  /**
   * The live claim that blocks another writer on the same body. An expired
   * lease is a lapsed claim: it does not block, and its holder gets the body
   * back through `renew` only while nobody else has taken it.
   */
  private writerConflict(
    characterId: string,
    worldId: string,
    except: StoredSession | null,
  ): StoredSession | undefined {
    return [...this.records.values()].find(
      (candidate) =>
        candidate !== except &&
        ownsBody(candidate) &&
        !this.expired(candidate) &&
        candidate.spec.characterId === characterId &&
        candidate.spec.worldId === worldId,
    );
  }

  private async attachRecord(record: StoredSession): Promise<void> {
    if (this.attached.has(record.spec.sessionId) || !ownsBody(record)) return;
    let session: EnvironmentAdapterSession | undefined;
    if (record.adapterSessionId !== null) {
      try {
        session = await this.adapter.attach(record.spec, record.adapterSessionId);
      } catch {
        session = undefined;
      }
    }
    if (!session) await this.fail(record, "adapter_session_missing");
    else this.attached.set(record.spec.sessionId, session);
  }

  private async fail(record: StoredSession, reason: string): Promise<void> {
    record.revokedAt = this.clock().toISOString();
    await this.cancelAll(record, "environment session failed");
    await this.attached
      .get(record.spec.sessionId)
      ?.stop("environment session failed")
      .catch(() => undefined);
    this.attached.delete(record.spec.sessionId);
    record.phase = "failed";
    await this.persist(record);
    await this.emit("environment.session.disconnected", record, record.correlationId, { reason });
  }

  private async stopRecord(record: StoredSession, reason: string): Promise<void> {
    if (record.phase === "off" || record.phase === "failed") return;
    const safe = this.safeText(record, safeReason(reason));
    record.revokedAt ??= this.clock().toISOString();
    record.phase = "stopping";
    await this.persist(record); // revoke before adapter I/O
    await this.cancelAll(record, safe);
    await this.attached
      .get(record.spec.sessionId)
      ?.stop(safe)
      .catch(() => undefined);
    this.attached.delete(record.spec.sessionId);
    record.phase = "off";
    await this.persist(record);
    await this.emit("environment.session.stopped", record, record.correlationId, { reason: safe });
  }

  private async cancelAll(record: StoredSession, reason: string): Promise<void> {
    for (const actionId of Object.keys(record.actions)) await this.cancelOne(record, actionId, reason);
  }

  private async cancelOne(
    record: StoredSession,
    actionId: string,
    reason: string,
  ): Promise<EnvironmentActionResult> {
    const action = mustAction(record, actionId);
    if (terminal(action.result)) return structuredClone(action.result);
    const safe = this.safeText(record, safeReason(reason));
    await this.attached
      .get(record.spec.sessionId)
      ?.cancelAction(actionId, safe)
      .catch(() => undefined);
    action.result = cancelled(action.result, this.clock(), safe);
    await this.persist(record);
    await this.emit("environment.action.cancelled", record, record.correlationId, {
      actionId,
      reason: safe,
    });
    return structuredClone(action.result);
  }

  private async sweepRecords(): Promise<{ expiredSessions: string[]; timedOutActions: string[] }> {
    const expiredSessions: string[] = [];
    const timedOutActions: string[] = [];
    for (const record of this.records.values()) {
      if (ownsBody(record) && !this.attached.has(record.spec.sessionId)) await this.attachRecord(record);
      if (!ownsBody(record)) continue;
      if (this.expired(record)) {
        if (record.leaseLapse == null) {
          await this.expireLease(record);
          expiredSessions.push(record.spec.sessionId);
        }
        // A lapsed session's actions were cancelled when the lapse was handled.
        continue;
      }
      timedOutActions.push(...(await this.cancelTimedOutActions(record)));
    }
    await this.pruneEndedRecords();
    return { expiredSessions, timedOutActions };
  }

  /** Cancel every non-terminal action past its deadline. Returns what it cancelled. */
  private async cancelTimedOutActions(record: StoredSession): Promise<string[]> {
    const cancelledIds: string[] = [];
    for (const [actionId, action] of Object.entries(record.actions)) {
      if (!terminal(action.result) && Date.parse(action.deadlineAt) <= this.clock().getTime()) {
        await this.cancelOne(record, actionId, "action timeout");
        cancelledIds.push(actionId);
      }
    }
    return cancelledIds;
  }

  /**
   * Retention for a session that outlives its usefulness as a record: only
   * terminal results roll (an in-flight action must stay cancellable and
   * idempotent), oldest first, and every drop is counted on the record.
   */
  private rollActions(record: StoredSession): void {
    const max = this.retention?.maxActionRecords;
    if (max === undefined) return;
    let excess = Object.keys(record.actions).length - max;
    if (excess <= 0) return;
    for (const [actionId, action] of Object.entries(record.actions)) {
      if (excess <= 0) break;
      if (!terminal(action.result)) continue;
      delete record.actions[actionId];
      record.rolledActionRecords = (record.rolledActionRecords ?? 0) + 1;
      excess -= 1;
    }
  }

  /**
   * Ended sessions keep their newest records for inspection and lose the rest,
   * so per-run session identities cannot grow the records directory without
   * bound. Live sessions are never candidates.
   */
  private async pruneEndedRecords(): Promise<void> {
    const max = this.retention?.maxEndedSessionRecords;
    if (max === undefined) return;
    const ended = [...this.records.values()]
      .filter((record) => record.phase === "off" || record.phase === "failed")
      .sort((a, b) => Date.parse(a.lease.issuedAt) - Date.parse(b.lease.issuedAt));
    while (ended.length > max) {
      const oldest = ended.shift();
      if (oldest === undefined) break;
      const sessionId = oldest.spec.sessionId;
      this.records.delete(sessionId);
      this.secrets.delete(sessionId);
      this.attached.delete(sessionId);
      await unlink(join(this.recordsDir(), `${hash(sessionId)}.json`)).catch(() => undefined);
    }
  }

  private async emit(
    type: EnvironmentSemanticEventType,
    record: StoredSession,
    correlationId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.events.append(
      EnvironmentSemanticEventSchema.parse({
        schemaVersion: 1,
        plane: "semantic",
        id: randomUUID(),
        type,
        occurredAt: this.clock().toISOString(),
        correlationId: this.safeText(record, correlationId),
        sessionId: record.spec.sessionId,
        ...(record.lease.missionId === undefined ? {} : { missionId: record.lease.missionId }),
        ...(record.lease.taskId === undefined ? {} : { taskId: record.lease.taskId }),
        data: sanitize(data, this.secretSet(record.spec.sessionId)),
      }),
    );
  }

  private expired(record: StoredSession): boolean {
    return Date.parse(record.lease.expiresAt) <= this.clock().getTime();
  }

  private safeText(record: StoredSession, value: string): string {
    return sanitize(value, this.secretSet(record.spec.sessionId)) as string;
  }

  private record(sessionId: string): StoredSession {
    const record = this.records.get(sessionId);
    if (!record) throw new Error(`Unknown environment session ${sessionId}`);
    return record;
  }

  private session(sessionId: string): EnvironmentAdapterSession {
    const session = this.attached.get(sessionId);
    if (!session) throw new Error(`Environment session ${sessionId} is not attached`);
    return session;
  }

  private secretSet(sessionId: string): Set<string> {
    const existing = this.secrets.get(sessionId);
    if (existing) return existing;
    const created = new Set<string>();
    this.secrets.set(sessionId, created);
    return created;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.recordsDir(), { recursive: true });
    for (const file of (await readdir(this.recordsDir())).filter((name) => name.endsWith(".json"))) {
      const path = join(this.recordsDir(), file);
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) throw new Error();
        const spec = normalizeEnvironmentSessionSpec(parsed.spec);
        const lease = normalizeEnvironmentLease(parsed.lease, spec);
        const current = {
          ...parsed,
          schemaVersion: 2,
          spec,
          lease,
        } as StoredSession;
        if (current.spec.sessionId.length === 0) throw new Error();
        this.records.set(current.spec.sessionId, current);
      } catch {
        throw new Error(`Corrupt environment session record ${path}`);
      }
    }
    this.loaded = true;
  }

  private async persist(record: StoredSession): Promise<void> {
    await mkdir(this.recordsDir(), { recursive: true });
    const target = join(this.recordsDir(), `${hash(record.spec.sessionId)}.json`);
    const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private recordsDir(): string {
    return join(this.rootDir, "environment-sessions");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ownsBody(record: StoredSession): boolean {
  return ["starting", "active", "paused", "stopping"].includes(record.phase);
}

function snapshot(record: StoredSession): EnvironmentSessionSnapshot {
  return {
    spec: structuredClone(record.spec),
    lease: structuredClone(record.lease),
    phase: record.phase,
    actions: Object.fromEntries(
      Object.entries(record.actions).map(([id, action]) => [id, structuredClone(action.result)]),
    ),
  };
}

function mustAction(record: StoredSession, actionId: string): StoredAction {
  const action = record.actions[actionId];
  if (!action) throw new Error(`Unknown environment action ${actionId}`);
  return action;
}

function terminal(result: EnvironmentActionResult): boolean {
  return ["completed", "cancelled", "failed", "denied", "stale"].includes(result.status);
}

function cancelled(result: EnvironmentActionResult, now: Date, reason: string): EnvironmentActionResult {
  const acceptedGoalVersion = "acceptedGoalVersion" in result ? result.acceptedGoalVersion : 0;
  return {
    schemaVersion: 1,
    actionId: result.actionId,
    sessionId: result.sessionId,
    status: "cancelled",
    acceptedGoalVersion,
    reason,
    updatedAt: now.toISOString(),
  };
}

function safeReason(reason: string): string {
  return reason.trim().slice(0, 512) || "unspecified";
}

function sanitize(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    let safe = value;
    for (const secret of secrets) if (secret.length > 0) safe = safe.replaceAll(secret, "[redacted]");
    return safe;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /(authorization|api.?key|token|secret|password|credential)/i.test(key)
        ? "[redacted]"
        : sanitize(entry, secrets),
    ]),
  );
}
