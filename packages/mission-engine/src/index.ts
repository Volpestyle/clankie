import { randomUUID } from "node:crypto";
import type { CompiledDoctrine } from "@sapling/doctrine";
import {
  type ApprovalRecord,
  type DomainEvent,
  type MissionPlan,
  type MissionState,
  type TaskSpec,
  type TaskState,
  type WorkerResult,
} from "@sapling/protocol";
import type { WorkerAdapter, WorkerDescriptor, WorkerRouter } from "@sapling/worker-sdk";
import { assertValidMissionPlan, type MissionPlanValidationEvidence } from "./plan-validator.ts";

export * from "./plan-validator.ts";

export interface TaskRuntime {
  spec: TaskSpec;
  state: TaskState;
  attempts: number;
  workerRunId?: string;
  workerId?: string;
  workerHarness?: string;
  runnerId?: string;
  leaseExpiresAt?: string;
  result?: WorkerResult;
  startedAt?: string;
  completedAt?: string;
}

export interface MissionSnapshot {
  id: string;
  goal: string;
  state: MissionState;
  profileHash: string;
  tasks: TaskRuntime[];
  approvals: ApprovalRecord[];
  planReview: MissionPlanReview;
  eventCount: number;
}

export type MissionPlanReview = Pick<
  MissionPlan,
  "rationale" | "assumptions" | "risks" | "humanDecisionsRequired" | "plannedActions"
> & { validation: MissionPlanValidationEvidence };

export interface MissionEngineOptions {
  workspacePath: string;
  clock?: () => Date;
  idFactory?: () => string;
  replayEvents?: readonly DomainEvent[];
}

export interface WorkerAssignment {
  missionId: string;
  profileHash: string;
  workerRunId: string;
  attempt: number;
  task: TaskSpec;
  worker: WorkerDescriptor;
  runnerId: string;
  leaseExpiresAt: string;
}

export interface WorkerEventInput {
  workerRunId: string;
  attempt: number;
  eventId: string;
  type: string;
  data: Record<string, unknown>;
}

export class WorkerRunConflictError extends Error {
  public readonly code:
    | "unknown_worker_run"
    | "stale_worker_run"
    | "worker_runner_mismatch"
    | "conflicting_settlement";

  public constructor(
    code: "unknown_worker_run" | "stale_worker_run" | "worker_runner_mismatch" | "conflicting_settlement",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "WorkerRunConflictError";
  }
}

export class MissionEngine {
  private readonly tasks = new Map<string, TaskRuntime>();
  private readonly events: DomainEvent[] = [];
  private readonly approvals: ApprovalRecord[] = [];
  private readonly assignmentsByClaimId = new Map<string, WorkerAssignment>();
  private readonly workerEventsById = new Map<string, DomainEvent>();
  private readonly settledRuns = new Map<
    string,
    { attempt: number; result: WorkerResult; taskId: string; runnerId: string }
  >();
  private state: MissionState = "draft";
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly correlationId: string;
  private planValidation: MissionPlanValidationEvidence;

  private readonly plan: MissionPlan;
  private readonly doctrine: CompiledDoctrine;
  private readonly options: MissionEngineOptions;

  public constructor(plan: MissionPlan, doctrine: CompiledDoctrine, options: MissionEngineOptions) {
    const planValidation = assertValidMissionPlan(plan);
    this.plan = plan;
    this.doctrine = doctrine;
    this.options = options;
    this.planValidation = planValidation;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.correlationId =
      options.replayEvents?.find((event) => event.missionId === plan.missionId)?.correlationId ??
      this.idFactory();
    for (const task of plan.tasks) {
      this.tasks.set(task.id, { spec: task, state: "queued", attempts: 0 });
    }
    const replayEvents = options.replayEvents?.filter((event) => event.missionId === plan.missionId) ?? [];
    if (replayEvents.length > 0) {
      for (const event of replayEvents) {
        this.events.push(structuredClone(event));
        this.applyReplayEvent(event);
      }
      this.recomputeState();
    } else {
      this.state = "running";
      this.emit("mission.created", { goal: plan.goal, taskCount: plan.tasks.length });
      this.emit("mission.started", { doctrine: doctrine.profile.id });
    }
  }

  public getSnapshot(): MissionSnapshot {
    return {
      id: this.plan.missionId,
      goal: this.plan.goal,
      state: this.state,
      profileHash: this.plan.profileHash,
      tasks: [...this.tasks.values()].map((task) => structuredClone(task)),
      approvals: structuredClone(this.approvals),
      planReview: {
        rationale: this.plan.rationale,
        assumptions: structuredClone(this.plan.assumptions),
        risks: structuredClone(this.plan.risks),
        humanDecisionsRequired: structuredClone(this.plan.humanDecisionsRequired),
        plannedActions: structuredClone(this.plan.plannedActions),
        validation: structuredClone(this.planValidation),
      },
      eventCount: this.events.length,
    };
  }

  public getEvents(): DomainEvent[] {
    return structuredClone(this.events);
  }

  public getTask(id: string): TaskRuntime {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    return structuredClone(task);
  }

  public addTask(spec: TaskSpec, causationId?: string): void {
    const validation = assertValidMissionPlan({
      ...this.plan,
      tasks: [...this.tasks.values()].map((task) => task.spec).concat(spec),
    });
    this.planValidation = validation;
    this.tasks.set(spec.id, { spec, state: "queued", attempts: 0 });
    this.emit("task.added", { title: spec.title, kind: spec.kind }, spec.id, undefined, causationId);
    if (this.state === "failed" || this.state === "blocked") this.state = "running";
  }

  public recordEvent(type: string, data: Record<string, unknown>, taskId?: string): DomainEvent {
    return this.emit(type, data, taskId);
  }

  /** Lease one dependency-ready task to an eligible runner worker. */
  public leaseReadyTask(
    workers: readonly WorkerDescriptor[],
    claimId: string,
    runnerId = "local",
    leaseDurationMs = 30_000,
  ): WorkerAssignment | undefined {
    const previous = this.assignmentsByClaimId.get(claimId);
    if (previous) {
      const runtime = this.tasks.get(previous.task.id);
      const stillActive =
        runtime !== undefined &&
        isActiveWorkerTaskState(runtime.state) &&
        runtime.workerRunId === previous.workerRunId &&
        runtime.attempts === previous.attempt;
      if (!stillActive) return undefined;
      if (previous.runnerId !== runnerId) {
        throw new WorkerRunConflictError(
          "worker_runner_mismatch",
          `Claim ${claimId} belongs to runner ${previous.runnerId}`,
        );
      }
      return structuredClone(previous);
    }
    const active = [...this.tasks.values()].filter(
      (task) => task.state === "leased" || isActiveWorkerTaskState(task.state),
    ).length;
    if (active >= this.doctrine.scheduler.maxParallelWorkers) return undefined;

    for (const runtime of this.tasks.values()) {
      if (
        runtime.state !== "queued" ||
        !runtime.spec.dependsOn.every((dependency) => this.tasks.get(dependency)?.state === "succeeded")
      ) {
        continue;
      }
      const excluded = this.excludedWorkers(runtime.spec);
      const worker = workers.find(
        (candidate) =>
          !excluded.has(candidate.id) &&
          candidate.capabilities.kinds.includes(runtime.spec.kind) &&
          (!runtime.spec.preferredHarness || candidate.harness === runtime.spec.preferredHarness) &&
          (runtime.spec.writeScope.length === 0 || candidate.capabilities.canWrite),
      );
      if (!worker) continue;

      runtime.attempts += 1;
      runtime.state = "running";
      runtime.startedAt = this.clock().toISOString();
      runtime.workerRunId = this.idFactory();
      runtime.workerId = worker.id;
      runtime.workerHarness = worker.harness;
      runtime.runnerId = runnerId;
      runtime.leaseExpiresAt = new Date(this.clock().getTime() + leaseDurationMs).toISOString();
      const assignment: WorkerAssignment = {
        missionId: this.plan.missionId,
        profileHash: this.plan.profileHash,
        workerRunId: runtime.workerRunId,
        attempt: runtime.attempts,
        task: structuredClone(runtime.spec),
        worker: structuredClone(worker),
        runnerId,
        leaseExpiresAt: runtime.leaseExpiresAt,
      };
      this.assignmentsByClaimId.set(claimId, assignment);
      this.emit(
        "worker.leased",
        {
          claimId,
          attempt: runtime.attempts,
          worker: structuredClone(worker),
          runnerId,
          leaseExpiresAt: runtime.leaseExpiresAt,
        },
        runtime.spec.id,
        runtime.workerRunId,
      );
      this.emit("task.started", { title: runtime.spec.title }, runtime.spec.id, runtime.workerRunId);
      this.recomputeState();
      return structuredClone(assignment);
    }
    this.recomputeState();
    return undefined;
  }

  /** Record one runner/provider event exactly once for the active attempt. */
  public recordWorkerEvent(input: WorkerEventInput, runnerId = "local"): DomainEvent {
    const eventKey = workerEventKey(input.workerRunId, input.attempt, input.eventId);
    const previous = this.workerEventsById.get(eventKey);
    if (previous) {
      const owner = previous.taskId ? this.tasks.get(previous.taskId)?.runnerId : undefined;
      if (owner !== runnerId) {
        throw new WorkerRunConflictError(
          "worker_runner_mismatch",
          `Worker run ${input.workerRunId} belongs to runner ${owner ?? "unknown"}`,
        );
      }
      return structuredClone(previous);
    }
    const runtime = this.findActiveRun(input.workerRunId, input.attempt, runnerId);
    const event = this.emit(input.type, input.data, runtime.spec.id, input.workerRunId, input.eventId);
    this.applyWorkerStatusEvent(runtime, input.type);
    this.workerEventsById.set(eventKey, event);
    return structuredClone(event);
  }

  /** Settle an exact worker attempt. Replays return the first settlement without another transition. */
  public settleWorkerRun(
    workerRunId: string,
    attempt: number,
    result: WorkerResult,
    runnerId = "local",
  ): TaskRuntime {
    const settled = this.settledRuns.get(workerRunId);
    if (settled) {
      if (settled.runnerId !== runnerId) {
        throw new WorkerRunConflictError(
          "worker_runner_mismatch",
          `Worker run ${workerRunId} belongs to runner ${settled.runnerId}`,
        );
      }
      if (settled.attempt !== attempt || JSON.stringify(settled.result) !== JSON.stringify(result)) {
        throw new WorkerRunConflictError(
          "conflicting_settlement",
          `Worker run ${workerRunId} was already settled with a different result`,
        );
      }
      return this.getTask(settled.taskId);
    }
    const runtime = this.findActiveRun(workerRunId, attempt, runnerId);
    runtime.result = structuredClone(result);
    runtime.completedAt = this.clock().toISOString();
    runtime.state =
      result.status === "succeeded" ? "succeeded" : result.status === "blocked" ? "blocked" : "failed";
    this.settledRuns.set(workerRunId, {
      attempt,
      result: structuredClone(result),
      taskId: runtime.spec.id,
      runnerId,
    });
    this.emit(
      `task.${runtime.state}`,
      { summary: result.summary, evidenceCount: result.evidence.length, diagnosis: result.diagnosis },
      runtime.spec.id,
      workerRunId,
    );
    this.emit(
      "worker.settled",
      { attempt, workerId: runtime.workerId, result: structuredClone(result) },
      runtime.spec.id,
      workerRunId,
    );
    delete runtime.workerRunId;
    delete runtime.leaseExpiresAt;
    this.recomputeState();
    return structuredClone(runtime);
  }

  public heartbeatWorkerRun(
    workerRunId: string,
    attempt: number,
    runnerId: string,
    leaseDurationMs = 30_000,
  ): TaskRuntime {
    const runtime = this.findActiveRun(workerRunId, attempt, runnerId);
    runtime.leaseExpiresAt = new Date(this.clock().getTime() + leaseDurationMs).toISOString();
    this.emit(
      "worker.lease.renewed",
      { attempt, runnerId, leaseExpiresAt: runtime.leaseExpiresAt },
      runtime.spec.id,
      workerRunId,
    );
    return structuredClone(runtime);
  }

  public expireAbandonedWorkerRuns(now = this.clock()): TaskRuntime[] {
    const expired: TaskRuntime[] = [];
    for (const runtime of this.tasks.values()) {
      if (
        !isActiveWorkerTaskState(runtime.state) ||
        !runtime.workerRunId ||
        !runtime.leaseExpiresAt ||
        Date.parse(runtime.leaseExpiresAt) > now.getTime()
      ) {
        continue;
      }
      expired.push(
        this.expireWorkerLease(runtime.spec.id, runtime.workerRunId, "runner heartbeat lease expired"),
      );
    }
    return expired;
  }

  /**
   * Lease surface for the runner: a worker whose process lease expired or was
   * lost leaves its task in a recoverable state — requeued while attempts
   * remain, failed explicitly otherwise. Never a silent loss. Idempotent for
   * tasks that are not currently leased or running.
   */
  public expireWorkerLease(taskId: string, workerRunId: string, reason: string): TaskRuntime {
    const runtime = this.tasks.get(taskId);
    if (!runtime) throw new Error(`Unknown task ${taskId}`);
    if (runtime.state !== "leased" && !isActiveWorkerTaskState(runtime.state)) {
      return structuredClone(runtime);
    }
    if (runtime.workerRunId !== workerRunId) {
      this.emit(
        "worker.lease.expiry.discarded",
        { reason, activeWorkerRunId: runtime.workerRunId },
        taskId,
        workerRunId,
      );
      return structuredClone(runtime);
    }
    if (runtime.attempts < runtime.spec.maxAttempts) {
      runtime.state = "queued";
      delete runtime.workerRunId;
      delete runtime.workerId;
      delete runtime.workerHarness;
      delete runtime.runnerId;
      delete runtime.leaseExpiresAt;
      this.emit("task.requeued", { reason, attempt: runtime.attempts }, taskId, workerRunId);
    } else {
      runtime.state = "failed";
      runtime.completedAt = this.clock().toISOString();
      runtime.result = {
        status: "failed",
        summary: "Worker lease expired with no attempts remaining.",
        evidence: [],
        outputs: {},
        diagnosis: reason,
      };
      this.emit("task.failed", { summary: runtime.result.summary, diagnosis: reason }, taskId, workerRunId);
      delete runtime.workerRunId;
      delete runtime.leaseExpiresAt;
    }
    this.recomputeState();
    return structuredClone(runtime);
  }

  public recordApproval(record: ApprovalRecord): void {
    this.approvals.push(record);
    this.emit("approval.recorded", {
      actionRequestId: record.actionRequestId,
      decision: record.decision,
      decidedBy: record.decidedBy,
    });
  }

  public completeMission(summary: string): void {
    this.state = "succeeded";
    this.emit("mission.succeeded", { summary });
  }

  public failMission(reason: string): void {
    this.state = "failed";
    this.emit("mission.failed", { reason });
  }

  public async runReadyTasks(router: WorkerRouter): Promise<TaskRuntime[]> {
    const ready = [...this.tasks.values()].filter(
      (task) =>
        task.state === "queued" &&
        task.spec.dependsOn.every((dependency) => this.tasks.get(dependency)?.state === "succeeded"),
    );

    if (ready.length === 0) return [];
    const batch = ready.slice(0, this.doctrine.scheduler.maxParallelWorkers);
    const settled = await Promise.all(batch.map((task) => this.runTask(task, router)));
    this.recomputeState();
    return settled;
  }

  public async runUntilIdle(router: WorkerRouter): Promise<MissionSnapshot> {
    while (true) {
      const ran = await this.runReadyTasks(router);
      if (ran.length === 0) break;
    }
    this.recomputeState();
    return this.getSnapshot();
  }

  private recomputeState(): void {
    if (this.state === "succeeded" || this.state === "cancelled") return;
    const runtimes = [...this.tasks.values()];
    if (runtimes.some((task) => task.state === "running" || task.state === "leased")) {
      this.state = "running";
      return;
    }
    if (runtimes.some((task) => task.state === "failed")) {
      this.state = "failed";
      return;
    }
    if (runtimes.some((task) => task.state === "blocked" || task.state === "waiting_user")) {
      this.state = "blocked";
      return;
    }
    if (runtimes.every((task) => task.state === "succeeded")) {
      this.state = "verifying";
      return;
    }
    this.state = "running";
  }

  private excludedWorkers(spec: TaskSpec): Set<string> {
    const excluded = new Set<string>();
    if (spec.kind === "verification" && this.doctrine.profile.verification.independentVerifier) {
      for (const dependency of spec.dependsOn) {
        const dependencyWorker = this.tasks.get(dependency)?.workerId;
        if (dependencyWorker) excluded.add(dependencyWorker);
      }
    }
    return excluded;
  }

  private findActiveRun(workerRunId: string, attempt: number, runnerId?: string): TaskRuntime {
    const runtime = [...this.tasks.values()].find((candidate) => candidate.workerRunId === workerRunId);
    if (!runtime) {
      throw new WorkerRunConflictError("unknown_worker_run", `Unknown active worker run ${workerRunId}`);
    }
    if (runtime.attempts !== attempt || !isActiveWorkerTaskState(runtime.state)) {
      throw new WorkerRunConflictError(
        "stale_worker_run",
        `Worker run ${workerRunId} attempt ${attempt} is not the active attempt`,
      );
    }
    if (runnerId !== undefined && runtime.runnerId !== runnerId) {
      throw new WorkerRunConflictError(
        "worker_runner_mismatch",
        `Worker run ${workerRunId} belongs to runner ${runtime.runnerId ?? "unknown"}`,
      );
    }
    return runtime;
  }

  private applyReplayEvent(event: DomainEvent): void {
    if (event.type === "worker.leased" && event.taskId && event.workerRunId) {
      const runtime = this.tasks.get(event.taskId);
      const worker = event.data.worker as WorkerDescriptor | undefined;
      const attempt = typeof event.data.attempt === "number" ? event.data.attempt : undefined;
      const claimId = typeof event.data.claimId === "string" ? event.data.claimId : undefined;
      const runnerId = typeof event.data.runnerId === "string" ? event.data.runnerId : undefined;
      const leaseExpiresAt =
        typeof event.data.leaseExpiresAt === "string" ? event.data.leaseExpiresAt : undefined;
      if (!runtime || !worker || !attempt || !claimId || !runnerId || !leaseExpiresAt) return;
      runtime.state = "running";
      runtime.attempts = attempt;
      runtime.workerRunId = event.workerRunId;
      runtime.workerId = worker.id;
      runtime.workerHarness = worker.harness;
      runtime.runnerId = runnerId;
      runtime.leaseExpiresAt = leaseExpiresAt;
      runtime.startedAt = event.occurredAt;
      this.assignmentsByClaimId.set(claimId, {
        missionId: this.plan.missionId,
        profileHash: this.plan.profileHash,
        workerRunId: event.workerRunId,
        attempt,
        task: structuredClone(runtime.spec),
        worker: structuredClone(worker),
        runnerId,
        leaseExpiresAt,
      });
      return;
    }
    if (event.type === "worker.settled" && event.taskId && event.workerRunId) {
      const runtime = this.tasks.get(event.taskId);
      const result = event.data.result as WorkerResult | undefined;
      const attempt = typeof event.data.attempt === "number" ? event.data.attempt : undefined;
      if (!runtime || !result || !attempt) return;
      runtime.attempts = attempt;
      runtime.result = structuredClone(result);
      runtime.completedAt = event.occurredAt;
      runtime.state =
        result.status === "succeeded" ? "succeeded" : result.status === "blocked" ? "blocked" : "failed";
      delete runtime.workerRunId;
      delete runtime.leaseExpiresAt;
      this.settledRuns.set(event.workerRunId, {
        attempt,
        result: structuredClone(result),
        taskId: runtime.spec.id,
        runnerId: runtime.runnerId ?? "unknown",
      });
      return;
    }
    if (event.type === "worker.lease.renewed" && event.taskId && event.workerRunId) {
      const runtime = this.tasks.get(event.taskId);
      if (runtime?.workerRunId === event.workerRunId && typeof event.data.leaseExpiresAt === "string") {
        runtime.leaseExpiresAt = event.data.leaseExpiresAt;
      }
      return;
    }
    if (
      (event.type === "worker.waiting_user" || event.type === "worker.turn.started") &&
      event.taskId &&
      event.workerRunId
    ) {
      const runtime = this.tasks.get(event.taskId);
      if (runtime?.workerRunId === event.workerRunId) {
        this.applyWorkerStatusEvent(runtime, event.type);
      }
    }
    if (event.type === "task.requeued" && event.taskId) {
      const runtime = this.tasks.get(event.taskId);
      if (runtime) {
        runtime.state = "queued";
        delete runtime.workerRunId;
        delete runtime.workerId;
        delete runtime.workerHarness;
        delete runtime.runnerId;
        delete runtime.leaseExpiresAt;
      }
      return;
    }
    if (event.type === "task.failed" && event.taskId) {
      const runtime = this.tasks.get(event.taskId);
      if (runtime) {
        runtime.state = "failed";
        runtime.completedAt = event.occurredAt;
        runtime.result = {
          status: "failed",
          summary: typeof event.data.summary === "string" ? event.data.summary : "Worker attempt failed.",
          evidence: [],
          outputs: {},
          ...(typeof event.data.diagnosis === "string" ? { diagnosis: event.data.diagnosis } : {}),
        };
        delete runtime.workerRunId;
        delete runtime.leaseExpiresAt;
      }
      return;
    }
    if (event.type === "mission.succeeded") {
      this.state = "succeeded";
      return;
    }
    if (event.workerRunId && event.type !== "task.started" && event.taskId) {
      const attempt = this.tasks.get(event.taskId)?.attempts;
      if (attempt) {
        this.workerEventsById.set(
          workerEventKey(event.workerRunId, attempt, event.causationId ?? event.id),
          event,
        );
      }
    }
  }

  private async runTask(runtime: TaskRuntime, router: WorkerRouter): Promise<TaskRuntime> {
    runtime.state = "leased";
    runtime.attempts += 1;

    const excluded = new Set<string>();
    if (runtime.spec.kind === "verification" && this.doctrine.profile.verification.independentVerifier) {
      for (const dependency of runtime.spec.dependsOn) {
        const dependencyWorker = this.tasks.get(dependency)?.workerId;
        if (dependencyWorker) excluded.add(dependencyWorker);
      }
    }

    let worker: WorkerAdapter;
    try {
      worker = router.select(runtime.spec, excluded);
    } catch (error) {
      runtime.state = "blocked";
      runtime.result = {
        status: "blocked",
        summary: "No eligible worker was available.",
        evidence: [],
        outputs: {},
        diagnosis: error instanceof Error ? error.message : String(error),
      };
      this.emit("task.blocked", { reason: runtime.result.diagnosis ?? "unknown" }, runtime.spec.id);
      return structuredClone(runtime);
    }

    runtime.workerId = worker.descriptor.id;
    runtime.workerHarness = worker.descriptor.harness;
    runtime.state = "running";
    runtime.startedAt = this.clock().toISOString();
    const workerRunId = this.idFactory();
    runtime.workerRunId = workerRunId;
    this.emit(
      "worker.started",
      {
        workerId: worker.descriptor.id,
        harness: worker.descriptor.harness,
        taskKind: runtime.spec.kind,
        attempt: runtime.attempts,
      },
      runtime.spec.id,
      workerRunId,
    );
    this.emit("task.started", { title: runtime.spec.title }, runtime.spec.id, workerRunId);

    const abortController = new AbortController();
    const attempt = runtime.attempts;
    // A lease expiry can requeue or fail this task while the worker promise is
    // still in flight; a stale settle must never overwrite the recovered state.
    const isStale = () =>
      runtime.attempts !== attempt ||
      !isActiveWorkerTaskState(runtime.state) ||
      runtime.workerRunId !== workerRunId;
    try {
      const result = await worker.run({
        missionId: this.plan.missionId,
        workerRunId,
        task: runtime.spec,
        workspacePath: this.options.workspacePath,
        profileHash: this.plan.profileHash,
        attempt: runtime.attempts,
        signal: abortController.signal,
        emit: (partial) => {
          this.emit(partial.type, partial.data, partial.taskId, workerRunId, partial.causationId);
          this.applyWorkerStatusEvent(runtime, partial.type);
        },
      });
      if (isStale()) {
        this.emit(
          "worker.result.discarded",
          { workerId: worker.descriptor.id, staleAttempt: attempt, result: result.status },
          runtime.spec.id,
          workerRunId,
        );
        return structuredClone(runtime);
      }
      runtime.result = result;
      runtime.completedAt = this.clock().toISOString();
      runtime.state =
        result.status === "succeeded" ? "succeeded" : result.status === "blocked" ? "blocked" : "failed";
      this.emit(
        `task.${runtime.state}`,
        { summary: result.summary, evidenceCount: result.evidence.length, diagnosis: result.diagnosis },
        runtime.spec.id,
        workerRunId,
      );
      this.emit(
        "worker.completed",
        { workerId: worker.descriptor.id, result: result.status },
        runtime.spec.id,
        workerRunId,
      );
      delete runtime.workerRunId;
    } catch (error) {
      if (isStale()) {
        this.emit(
          "worker.result.discarded",
          { workerId: worker.descriptor.id, staleAttempt: attempt, result: "error" },
          runtime.spec.id,
          workerRunId,
        );
        return structuredClone(runtime);
      }
      runtime.completedAt = this.clock().toISOString();
      runtime.state = "failed";
      runtime.result = {
        status: "failed",
        summary: "Worker threw an unhandled error.",
        evidence: [],
        outputs: {},
        diagnosis: error instanceof Error ? (error.stack ?? error.message) : String(error),
      };
      this.emit(
        "task.failed",
        { summary: runtime.result.summary, diagnosis: runtime.result.diagnosis },
        runtime.spec.id,
        workerRunId,
      );
      this.emit("worker.crashed", { workerId: worker.descriptor.id }, runtime.spec.id, workerRunId);
      delete runtime.workerRunId;
    }
    return structuredClone(runtime);
  }

  private applyWorkerStatusEvent(runtime: TaskRuntime, type: string): void {
    if (type === "worker.waiting_user") {
      runtime.state = "waiting_user";
      this.recomputeState();
    } else if (type === "worker.turn.started" && runtime.state === "waiting_user") {
      runtime.state = "running";
      this.recomputeState();
    }
  }

  private emit(
    type: string,
    data: Record<string, unknown>,
    taskId?: string,
    workerRunId?: string,
    causationId?: string,
    eventId?: string,
  ): DomainEvent {
    const event: DomainEvent = {
      id: eventId ?? this.idFactory(),
      occurredAt: this.clock().toISOString(),
      missionId: this.plan.missionId,
      correlationId: this.correlationId,
      profileHash: this.plan.profileHash,
      type,
      data,
      ...(taskId ? { taskId } : {}),
      ...(workerRunId ? { workerRunId } : {}),
      ...(causationId ? { causationId } : {}),
    };
    this.events.push(event);
    return event;
  }
}

function workerEventKey(workerRunId: string, attempt: number, eventId: string): string {
  return `${workerRunId}\0${attempt}\0${eventId}`;
}

function isActiveWorkerTaskState(state: TaskState): boolean {
  return state === "running" || state === "waiting_user";
}
