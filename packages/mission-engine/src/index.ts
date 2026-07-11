import { randomUUID } from "node:crypto";
import type { CompiledDoctrine } from "@sapling/doctrine";
import {
  assertValidDag,
  type ApprovalRecord,
  type DomainEvent,
  type MissionPlan,
  type MissionState,
  type TaskSpec,
  type TaskState,
  type WorkerResult,
} from "@sapling/protocol";
import type { WorkerAdapter, WorkerRouter } from "@sapling/worker-sdk";

export interface TaskRuntime {
  spec: TaskSpec;
  state: TaskState;
  attempts: number;
  workerId?: string;
  workerHarness?: string;
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
  eventCount: number;
}

export interface MissionEngineOptions {
  workspacePath: string;
  clock?: () => Date;
  idFactory?: () => string;
}

export class MissionEngine {
  private readonly tasks = new Map<string, TaskRuntime>();
  private readonly events: DomainEvent[] = [];
  private readonly approvals: ApprovalRecord[] = [];
  private state: MissionState = "draft";
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly correlationId: string;

  private readonly plan: MissionPlan;
  private readonly doctrine: CompiledDoctrine;
  private readonly options: MissionEngineOptions;

  public constructor(plan: MissionPlan, doctrine: CompiledDoctrine, options: MissionEngineOptions) {
    this.plan = plan;
    this.doctrine = doctrine;
    this.options = options;
    assertValidDag(plan.tasks);
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.correlationId = this.idFactory();
    for (const task of plan.tasks) {
      this.tasks.set(task.id, { spec: task, state: "queued", attempts: 0 });
    }
    this.state = "running";
    this.emit("mission.created", { goal: plan.goal, taskCount: plan.tasks.length });
    this.emit("mission.started", { doctrine: doctrine.profile.id });
  }

  public getSnapshot(): MissionSnapshot {
    return {
      id: this.plan.missionId,
      goal: this.plan.goal,
      state: this.state,
      profileHash: this.plan.profileHash,
      tasks: [...this.tasks.values()].map((task) => structuredClone(task)),
      approvals: structuredClone(this.approvals),
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
    if (this.tasks.has(spec.id)) throw new Error(`Task ${spec.id} already exists`);
    for (const dependency of spec.dependsOn) {
      if (!this.tasks.has(dependency))
        throw new Error(`Task ${spec.id} depends on unknown task ${dependency}`);
    }
    this.tasks.set(spec.id, { spec, state: "queued", attempts: 0 });
    this.emit("task.added", { title: spec.title, kind: spec.kind }, spec.id, undefined, causationId);
    if (this.state === "failed" || this.state === "blocked") this.state = "running";
  }

  public recordEvent(type: string, data: Record<string, unknown>, taskId?: string): DomainEvent {
    return this.emit(type, data, taskId);
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
    if (runtime.state !== "leased" && runtime.state !== "running") {
      return structuredClone(runtime);
    }
    if (runtime.attempts < runtime.spec.maxAttempts) {
      runtime.state = "queued";
      delete runtime.workerId;
      delete runtime.workerHarness;
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
    const isStale = () => runtime.attempts !== attempt || runtime.state !== "running";
    try {
      const result = await worker.run({
        missionId: this.plan.missionId,
        task: runtime.spec,
        workspacePath: this.options.workspacePath,
        profileHash: this.plan.profileHash,
        attempt: runtime.attempts,
        signal: abortController.signal,
        emit: (partial) => {
          this.emit(partial.type, partial.data, partial.taskId, partial.workerRunId, partial.causationId);
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
    }
    return structuredClone(runtime);
  }

  private emit(
    type: string,
    data: Record<string, unknown>,
    taskId?: string,
    workerRunId?: string,
    causationId?: string,
  ): DomainEvent {
    const event: DomainEvent = {
      id: this.idFactory(),
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
