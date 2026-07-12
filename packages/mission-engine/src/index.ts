import { createHash, randomUUID } from "node:crypto";
import type { CompiledDoctrine } from "@clankie/doctrine";
import {
  type ApprovalRecord,
  type DomainEvent,
  type MissionPlan,
  type MissionState,
  TaskSpecSchema,
  type TaskSpec,
  type TaskState,
  type WorkerResult,
} from "@clankie/protocol";
import type { WorkerAdapter, WorkerDescriptor, WorkerRouter } from "@clankie/worker-sdk";
import {
  AgentStatusResolver,
  STATUS_RESOLVED_EVENT_TYPE,
  toResolvedStatusEventData,
  type ResolvedAgentStatus,
} from "@clankie/status-resolver";
import { assertValidMissionPlan, type MissionPlanValidationEvidence } from "./plan-validator.ts";

export * from "./plan-validator.ts";

/** The structured, non-reasoning evidence a debugger is allowed to consume. */
export interface FailureEvidence {
  sourceTaskId: string;
  sourceAttempt: number;
  sourceWorkerRunId?: string;
  command: string;
  exitCode: number;
  outputArtifact: string;
}

export interface VerificationContract {
  acceptanceCriteria: string[];
  requiredChecks: string[];
  unchangedAcceptanceChecks: true;
  huntsCounterexamples: true;
  readOnly: true;
}

export interface DebuggerReproductionEvidence {
  command: string;
  exitCode: number;
  outputArtifact: string;
}

export interface DebuggerRepairEvidence {
  reproduction: DebuggerReproductionEvidence;
  before: string[];
  after: string[];
}

export const FAILURE_EVIDENCE_METADATA_KEY = "missionEngine.failureEvidence";
export const VERIFICATION_CONTRACT_METADATA_KEY = "missionEngine.verificationContract";
export const DEBUGGER_CONTRACT_METADATA_KEY = "missionEngine.debuggerContract";

export interface TaskRuntime {
  spec: TaskSpec;
  state: TaskState;
  attempts: number;
  /** Every worker identity that has implemented this task, including retries. */
  workerIds: string[];
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
  workerStatuses: ResolvedAgentStatus[];
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

export interface RecoveryPairInput {
  commandId: string;
  failedTaskId: string;
  debugger: TaskSpec;
  reverify: TaskSpec;
}

export interface RecoveryPair {
  commandId: string;
  failedTaskId: string;
  debugger: TaskRuntime;
  reverify: TaskRuntime;
  requiredCheckIdentities: string[];
}

interface RecoveryCommandRecord {
  fingerprint: string;
  failedTaskId: string;
  debuggerTaskId: string;
  reverifyTaskId: string;
  requiredCheckIdentities: string[];
}

export class RecoveryConflictError extends Error {
  public readonly code: "invalid_recovery" | "recovery_already_exists" | "conflicting_recovery_command";

  public constructor(
    code: "invalid_recovery" | "recovery_already_exists" | "conflicting_recovery_command",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "RecoveryConflictError";
  }
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
  private readonly statusResolver = new AgentStatusResolver();
  private readonly settledRuns = new Map<
    string,
    { attempt: number; result: WorkerResult; taskId: string; runnerId: string }
  >();
  private readonly debuggerEvidenceByRunId = new Map<string, { reproduced: boolean; repaired: boolean }>();
  /** Task ids that have emitted an unacknowledged pull-path exclusion-starve signal. */
  private readonly verificationStarveSignaled = new Set<string>();
  /** Debugging task ids whose runtime failure evidence has been bound (bridge, VUH-827). */
  private readonly runtimeEvidenceBound = new Set<string>();
  /** Debugging task ids that have emitted an unacknowledged dependency-evidence-starve signal. */
  private readonly debuggerEvidenceStarveSignaled = new Set<string>();
  private readonly recoveryCommands = new Map<string, RecoveryCommandRecord>();
  private readonly recoveryByFailedTask = new Map<string, string>();
  private readonly resolvedFailedTasks = new Map<string, string>();
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
      this.tasks.set(task.id, { spec: task, state: "queued", attempts: 0, workerIds: [] });
    }
    const replayEvents = options.replayEvents?.filter((event) => event.missionId === plan.missionId) ?? [];
    if (replayEvents.length > 0) {
      for (const event of replayEvents) {
        this.events.push(structuredClone(event));
        this.applyReplayEvent(event);
      }
      this.planValidation = assertValidMissionPlan({
        ...this.plan,
        tasks: [...this.tasks.values()].map((task) => task.spec),
      });
      // Rebuild the runtime failure-evidence bridge from the replayed settled
      // verification results so a rehydrated engine readies dependent debuggers
      // exactly as the live engine did — without re-emitting events (VUH-827).
      this.reconcileFailedVerificationBridges({ emit: false });
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
      workerStatuses: this.statusResolver.list(),
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

  public explainWorkerStatus(workerRunId: string): ResolvedAgentStatus | undefined {
    const status = this.statusResolver.explain(workerRunId);
    return status ? structuredClone(status) : undefined;
  }

  public addTask(spec: TaskSpec, causationId?: string): void {
    if (this.tasks.has(spec.id)) throw new Error(`Task ${spec.id} already exists`);
    const validation = assertValidMissionPlan({
      ...this.plan,
      tasks: [...this.tasks.values()].map((task) => task.spec).concat(spec),
    });
    this.planValidation = validation;
    this.tasks.set(spec.id, { spec, state: "queued", attempts: 0, workerIds: [] });
    this.emit(
      "task.added",
      { title: spec.title, kind: spec.kind, spec: structuredClone(spec) },
      spec.id,
      undefined,
      causationId,
    );
    if (this.state === "failed" || this.state === "blocked") this.state = "running";
  }

  /**
   * Add a repair task with an explicit verifier-produced failure contract.
   * The lead's diagnosis is deliberately not accepted as a substitute for
   * the command, exit code, and output artifact that reproduce the failure.
   */
  public addDebuggerTask(spec: TaskSpec, failure: FailureEvidence, causationId?: string): void {
    assertFailureEvidence(failure);
    if (spec.kind !== "debugging" || spec.role !== "debugger") {
      throw new Error("Debugger tasks must use kind debugging and role debugger");
    }
    if (!spec.dependsOn.includes(failure.sourceTaskId)) {
      throw new Error(
        `Debugger task "${spec.id}" must depend on its source verification task "${failure.sourceTaskId}"`,
      );
    }
    const source = this.tasks.get(failure.sourceTaskId);
    if (!source || source.spec.kind !== "verification") {
      throw new Error(
        `Failure evidence must reference an existing verification task: ${failure.sourceTaskId}`,
      );
    }
    if (source.state !== "failed") {
      throw new Error(`Failure evidence source "${failure.sourceTaskId}" is not a failed verification task`);
    }
    if (source.attempts !== failure.sourceAttempt) {
      throw new Error(
        `Failure evidence attempt ${failure.sourceAttempt} does not match source verification attempt ${source.attempts}`,
      );
    }
    const enriched: TaskSpec = {
      ...spec,
      metadata: {
        ...spec.metadata,
        [FAILURE_EVIDENCE_METADATA_KEY]: structuredClone(failure),
        [DEBUGGER_CONTRACT_METADATA_KEY]: true,
      },
    };
    this.addTask(enriched, causationId ?? failure.sourceTaskId);
    this.emit(
      "debugger.evidence.bound",
      {
        sourceTaskId: failure.sourceTaskId,
        sourceAttempt: failure.sourceAttempt,
        command: failure.command,
        exitCode: failure.exitCode,
        outputArtifact: failure.outputArtifact,
      },
      spec.id,
      undefined,
      causationId ?? failure.sourceTaskId,
    );
  }

  public getFailureEvidence(taskId: string): FailureEvidence | undefined {
    const task = this.tasks.get(taskId);
    const value = task?.spec.metadata[FAILURE_EVIDENCE_METADATA_KEY];
    return isFailureEvidence(value) ? structuredClone(value) : undefined;
  }

  public getVerificationContract(taskId: string): VerificationContract | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.spec.kind !== "verification") return undefined;
    return structuredClone(this.verificationContract(task.spec));
  }

  /** Add one trusted debugger + unchanged re-verifier pair after an observed verifier failure. */
  public addRecoveryPair(input: RecoveryPairInput): RecoveryPair {
    if (
      Object.hasOwn(input.debugger.metadata, "recovery") ||
      Object.hasOwn(input.reverify.metadata, "recovery")
    ) {
      throw new RecoveryConflictError(
        "invalid_recovery",
        "Recovery metadata is reserved for the trusted mission engine",
      );
    }
    const failed = this.tasks.get(input.failedTaskId);
    if (
      !failed ||
      failed.state !== "failed" ||
      failed.result?.status !== "failed" ||
      failed.spec.kind !== "verification" ||
      failed.spec.role !== "verifier" ||
      failed.spec.writeScope.length !== 0
    ) {
      throw new RecoveryConflictError(
        "invalid_recovery",
        `Task ${input.failedTaskId} is not a failed read-only verifier task`,
      );
    }
    const existingCommand = this.recoveryCommands.get(input.commandId);
    const requiredCheckIdentities = verificationCheckIdentities(failed.result);
    if (requiredCheckIdentities.length === 0) {
      throw new RecoveryConflictError(
        "invalid_recovery",
        `Task ${input.failedTaskId} has no trusted test_report check identities`,
      );
    }
    const implementationDependencies = failed.spec.dependsOn.map((taskId) => this.tasks.get(taskId));
    if (
      implementationDependencies.length === 0 ||
      implementationDependencies.some(
        (runtime) =>
          !runtime || runtime.spec.kind !== "implementation" || runtime.spec.role !== "implementer",
      )
    ) {
      throw new RecoveryConflictError(
        "invalid_recovery",
        `Failed verifier ${input.failedTaskId} does not have implementation lineage`,
      );
    }
    const expectedWriteScope = [
      ...new Set(implementationDependencies.flatMap((runtime) => runtime?.spec.writeScope ?? [])),
    ].sort();
    if (
      input.debugger.kind !== "debugging" ||
      input.debugger.role !== "debugger" ||
      !sameStrings(input.debugger.writeScope, expectedWriteScope) ||
      !sameStrings(input.debugger.dependsOn, failed.spec.dependsOn)
    ) {
      throw new RecoveryConflictError(
        "invalid_recovery",
        "The debugger must inherit the failed verifier's implementation lineage and exact write scope",
      );
    }
    if (
      input.reverify.kind !== "verification" ||
      input.reverify.role !== "verifier" ||
      input.reverify.writeScope.length !== 0 ||
      input.reverify.dependsOn.length !== 1 ||
      input.reverify.dependsOn[0] !== input.debugger.id
    ) {
      throw new RecoveryConflictError(
        "invalid_recovery",
        "The recovery verifier must be read-only and depend only on the debugger",
      );
    }
    if (input.debugger.id === input.reverify.id) {
      throw new RecoveryConflictError("invalid_recovery", "Recovery task ids must be distinct");
    }

    const authority = {
      schemaVersion: 1,
      commandId: input.commandId,
      failedTaskId: input.failedTaskId,
      diagnosis: failed.result.diagnosis ?? failed.result.summary,
      failedEvidence: structuredClone(failed.result.evidence),
      requiredCheckIdentities,
      testIntegrity: "unchanged",
    } as const;
    const debuggerSpec: TaskSpec = {
      ...structuredClone(input.debugger),
      metadata: { ...structuredClone(input.debugger.metadata), recovery: authority },
    };
    const reverifySpec: TaskSpec = {
      ...structuredClone(input.reverify),
      metadata: {
        ...structuredClone(input.reverify.metadata),
        recovery: { ...authority, debuggerTaskId: debuggerSpec.id },
      },
    };
    const fingerprint = recoveryFingerprint({
      commandId: input.commandId,
      failedTaskId: input.failedTaskId,
      debugger: debuggerSpec,
      reverify: reverifySpec,
    });
    if (existingCommand) {
      if (existingCommand.fingerprint !== fingerprint) {
        throw new RecoveryConflictError(
          "conflicting_recovery_command",
          `Recovery command ${input.commandId} was reused with different content`,
        );
      }
      return this.recoveryPair(existingCommand);
    }
    const existingForFailure = this.recoveryByFailedTask.get(input.failedTaskId);
    if (existingForFailure) {
      throw new RecoveryConflictError(
        "recovery_already_exists",
        `Failed task ${input.failedTaskId} already has recovery command ${existingForFailure}`,
      );
    }
    if (this.tasks.has(debuggerSpec.id) || this.tasks.has(reverifySpec.id)) {
      throw new RecoveryConflictError("invalid_recovery", "A recovery task id already exists");
    }
    const validation = assertValidMissionPlan({
      ...this.plan,
      tasks: [...this.tasks.values()].map((task) => task.spec).concat(debuggerSpec, reverifySpec),
    });
    this.planValidation = validation;
    this.tasks.set(debuggerSpec.id, { spec: debuggerSpec, state: "queued", attempts: 0, workerIds: [] });
    this.tasks.set(reverifySpec.id, { spec: reverifySpec, state: "queued", attempts: 0, workerIds: [] });
    const record: RecoveryCommandRecord = {
      fingerprint,
      failedTaskId: input.failedTaskId,
      debuggerTaskId: debuggerSpec.id,
      reverifyTaskId: reverifySpec.id,
      requiredCheckIdentities,
    };
    this.recoveryCommands.set(input.commandId, record);
    this.recoveryByFailedTask.set(input.failedTaskId, input.commandId);
    this.emit(
      "recovery.pair.added",
      {
        ...record,
        commandId: input.commandId,
        debuggerSpec: structuredClone(debuggerSpec),
        reverifySpec: structuredClone(reverifySpec),
      },
      undefined,
      undefined,
      input.commandId,
    );
    this.recomputeState();
    return this.recoveryPair(record);
  }

  /** Preserve the historical failure while accepting an unchanged successful re-verification. */
  public resolveFailedVerification(failedTaskId: string, reverifyTaskId: string): void {
    const previous = this.resolvedFailedTasks.get(failedTaskId);
    if (previous) {
      if (previous !== reverifyTaskId) {
        throw new RecoveryConflictError(
          "invalid_recovery",
          `Failed task ${failedTaskId} was already resolved by ${previous}`,
        );
      }
      return;
    }
    const commandId = this.recoveryByFailedTask.get(failedTaskId);
    const record = commandId ? this.recoveryCommands.get(commandId) : undefined;
    const reverify = this.tasks.get(reverifyTaskId);
    if (
      !record ||
      record.reverifyTaskId !== reverifyTaskId ||
      reverify?.state !== "succeeded" ||
      reverify.result?.status !== "succeeded" ||
      !sameStrings(verificationCheckIdentities(reverify.result), record.requiredCheckIdentities)
    ) {
      throw new RecoveryConflictError(
        "invalid_recovery",
        `Task ${reverifyTaskId} does not provide unchanged successful verification for ${failedTaskId}`,
      );
    }
    this.resolvedFailedTasks.set(failedTaskId, reverifyTaskId);
    this.emit(
      "task.failure.resolved",
      { failedTaskId, reverifyTaskId, requiredCheckIdentities: record.requiredCheckIdentities },
      failedTaskId,
      undefined,
      commandId,
    );
    this.recomputeState();
  }

  public isReadyForCompletion(): boolean {
    const runtimes = [...this.tasks.values()];
    return (
      runtimes.length > 0 &&
      runtimes.every(
        (runtime) =>
          runtime.state === "succeeded" ||
          (runtime.state === "failed" && this.resolvedFailedTasks.has(runtime.spec.id)),
      )
    );
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
      if (runtime.state !== "queued" || !this.dependenciesReady(runtime.spec)) {
        continue;
      }
      const excluded = this.excludedWorkers(runtime.spec);
      const isCapable = (candidate: WorkerDescriptor): boolean =>
        candidate.capabilities.kinds.includes(runtime.spec.kind) &&
        (!runtime.spec.preferredHarness || candidate.harness === runtime.spec.preferredHarness) &&
        (runtime.spec.writeScope.length === 0 || candidate.capabilities.canWrite);
      const worker = workers.find((candidate) => !excluded.has(candidate.id) && isCapable(candidate));
      if (!worker) {
        this.signalVerificationStarveIfExcluded(runtime, workers, excluded, isCapable);
        continue;
      }
      this.verificationStarveSignaled.delete(runtime.spec.id);

      runtime.attempts += 1;
      runtime.state = "running";
      runtime.startedAt = this.clock().toISOString();
      runtime.workerRunId = this.idFactory();
      runtime.workerId = worker.id;
      this.recordWorkerIdentity(runtime, worker.id);
      runtime.workerHarness = worker.harness;
      runtime.runnerId = runnerId;
      runtime.leaseExpiresAt = new Date(this.clock().getTime() + leaseDurationMs).toISOString();
      const assignment: WorkerAssignment = {
        missionId: this.plan.missionId,
        profileHash: this.plan.profileHash,
        workerRunId: runtime.workerRunId,
        attempt: runtime.attempts,
        task: this.taskForWorker(runtime.spec),
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
      this.emit(
        "task.started",
        { title: runtime.spec.title, ...this.verificationStartedEventData(runtime) },
        runtime.spec.id,
        runtime.workerRunId,
      );
      this.emitTaskContractStarted(runtime, runtime.workerRunId);
      this.recomputeState();
      return structuredClone(assignment);
    }
    this.recomputeState();
    return undefined;
  }

  /**
   * Make pull-path exclusion starvation observable. When a ready task has capable
   * workers on offer but every one of them is excluded (the independent-verifier
   * conflict), emit a `task.verification_starved` event once per episode — the
   * pull-path equivalent of the push path's `task.blocked`. The task stays queued
   * and recovers silently once an eligible worker is offered (the signal is
   * cleared on a successful lease), so the event is not re-emitted every poll.
   * Plain availability starvation (no capable worker offered at all) is normal
   * and stays silent.
   */
  private signalVerificationStarveIfExcluded(
    runtime: TaskRuntime,
    workers: readonly WorkerDescriptor[],
    excluded: ReadonlySet<string>,
    isCapable: (candidate: WorkerDescriptor) => boolean,
  ): void {
    if (excluded.size === 0 || this.verificationStarveSignaled.has(runtime.spec.id)) return;
    const excludedCapable = workers.filter((candidate) => excluded.has(candidate.id) && isCapable(candidate));
    if (excludedCapable.length === 0) return;
    this.verificationStarveSignaled.add(runtime.spec.id);
    this.emit(
      "task.verification_starved",
      {
        reason:
          "Every offered worker capable of this verification is excluded as a writer ancestor; provide an independent verifier.",
        excludedWorkerIds: excludedCapable.map((candidate) => candidate.id).sort(),
      },
      runtime.spec.id,
    );
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
    this.validateWorkerSemanticEvent(runtime, input.workerRunId, input.type, input.data);
    const event = this.emit(input.type, input.data, runtime.spec.id, input.workerRunId, input.eventId);
    this.recordWorkerSemanticEvent(input.workerRunId, input.type);
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
    this.ingestDebuggerResultEvidence(runtime, workerRunId, result);
    const contractFailure = this.contractFailure(runtime, workerRunId);
    const settledResult: WorkerResult = contractFailure
      ? { ...result, status: "failed", summary: contractFailure, diagnosis: contractFailure }
      : structuredClone(result);
    runtime.result = settledResult;
    runtime.completedAt = this.clock().toISOString();
    runtime.state =
      settledResult.status === "succeeded"
        ? "succeeded"
        : settledResult.status === "blocked"
          ? "blocked"
          : "failed";
    this.settledRuns.set(workerRunId, {
      attempt,
      result: structuredClone(settledResult),
      taskId: runtime.spec.id,
      runnerId,
    });
    // This is the canonical durable settlement. It must precede projection
    // events so every persisted terminal prefix retains the complete result.
    this.emit(
      "worker.settled",
      { attempt, workerId: runtime.workerId, result: structuredClone(settledResult) },
      runtime.spec.id,
      workerRunId,
    );
    this.emit(
      `task.${runtime.state}`,
      {
        summary: settledResult.summary,
        evidenceCount: settledResult.evidence.length,
        diagnosis: settledResult.diagnosis,
        ...this.verificationResultEventData(runtime),
      },
      runtime.spec.id,
      workerRunId,
    );
    this.emitTaskContractCompleted(runtime, workerRunId, settledResult);
    delete runtime.workerRunId;
    delete runtime.leaseExpiresAt;
    this.reconcileFailedVerificationBridges({ emit: true });
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
    if (this.state === "succeeded") return;
    this.state = "succeeded";
    this.emit("mission.succeeded", { summary });
  }

  public failMission(reason: string): void {
    this.state = "failed";
    this.emit("mission.failed", { reason });
  }

  public async runReadyTasks(router: WorkerRouter): Promise<TaskRuntime[]> {
    const ready = [...this.tasks.values()].filter(
      (task) => task.state === "queued" && this.dependenciesReady(task.spec),
    );

    if (ready.length === 0) return [];
    const batch = ready.slice(0, this.doctrine.scheduler.maxParallelWorkers);
    const settled = await Promise.all(batch.map((task) => this.runTask(task, router)));
    this.reconcileFailedVerificationBridges({ emit: true });
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
    // A failed verification superseded by a successful post-debug re-verification
    // (VUH-827 bridge) or resolved through a trusted recovery pair is recovery,
    // not terminal failure. Every other failure — a plain failed verification
    // with no repair chain, or any failed non-verification task — still fails
    // the mission, preserving the original semantics.
    if (
      runtimes.some(
        (task) =>
          task.state === "failed" &&
          !this.isSupersededVerification(task) &&
          !this.resolvedFailedTasks.has(task.spec.id),
      )
    ) {
      this.state = "failed";
      return;
    }
    if (runtimes.some((task) => task.state === "blocked" || task.state === "waiting_user")) {
      this.state = "blocked";
      return;
    }
    if (runtimes.every((task) => task.state === "succeeded" || this.isSupersededVerification(task))) {
      this.state = "verifying";
      return;
    }
    this.state = "running";
  }

  /**
   * True when a failed verification task has been repaired by a dependent
   * debugging task that succeeded AND re-verified by a later verification task
   * (depending on that repair) that also succeeded — the frozen-scenario
   * recovery chain. Absent the full chain the failure is not superseded.
   */
  private isSupersededVerification(runtime: TaskRuntime): boolean {
    if (runtime.spec.kind !== "verification" || runtime.state !== "failed") return false;
    const repairs = [...this.tasks.values()].filter(
      (task) =>
        task.spec.kind === "debugging" &&
        task.state === "succeeded" &&
        task.spec.dependsOn.includes(runtime.spec.id),
    );
    return repairs.some((repair) =>
      [...this.tasks.values()].some(
        (task) =>
          task.spec.kind === "verification" &&
          task.state === "succeeded" &&
          task.spec.dependsOn.includes(repair.spec.id),
      ),
    );
  }

  /**
   * Bridge for static frozen-scenario plans (VUH-827). When a planned
   * verification task has failed and a planned debugging task depends on it, the
   * debugger can only ready if `getFailureEvidence` resolves — but static plans
   * never call `addDebuggerTask`. Synthesize the strict `FailureEvidence` from
   * the verification's recorded runtime result (exact failing command, exit
   * code, and output artifact the runner already reported) and bind it, so the
   * existing `dependenciesReady` debugger path readies the repair. The bound
   * evidence satisfies `isFailureEvidence` exactly; no debugger contract is
   * imposed (that stays the explicit `addDebuggerTask` regime). When the failure
   * yields no reproducible command/exit-code (e.g. no runner check ran), the
   * debugger cannot ready and a dependency-starve event is emitted once.
   */
  private reconcileFailedVerificationBridges(options: { emit: boolean }): void {
    for (const verification of this.tasks.values()) {
      if (verification.spec.kind !== "verification" || verification.state !== "failed") continue;
      const dependents = [...this.tasks.values()].filter(
        (task) =>
          task.spec.kind === "debugging" &&
          task.spec.dependsOn.includes(verification.spec.id) &&
          this.getFailureEvidence(task.spec.id) === undefined,
      );
      if (dependents.length === 0) continue;
      const evidence = verification.result
        ? this.synthesizeFailureEvidence(verification, verification.result)
        : undefined;
      for (const debugging of dependents) {
        if (evidence) {
          debugging.spec = {
            ...debugging.spec,
            metadata: {
              ...debugging.spec.metadata,
              [FAILURE_EVIDENCE_METADATA_KEY]: structuredClone(evidence),
            },
          };
          if (options.emit && !this.runtimeEvidenceBound.has(debugging.spec.id)) {
            this.runtimeEvidenceBound.add(debugging.spec.id);
            this.emit(
              "debugger.failure_evidence.bound",
              {
                sourceTaskId: evidence.sourceTaskId,
                sourceAttempt: evidence.sourceAttempt,
                command: evidence.command,
                exitCode: evidence.exitCode,
                outputArtifact: evidence.outputArtifact,
                boundAtRuntime: true,
              },
              debugging.spec.id,
            );
          }
        } else if (options.emit && !this.debuggerEvidenceStarveSignaled.has(debugging.spec.id)) {
          this.debuggerEvidenceStarveSignaled.add(debugging.spec.id);
          this.emit(
            "task.debugger_evidence_starved",
            {
              reason:
                "The source verification failed without a reproducible runner check (no command/exit-code to bind as failure evidence); this debugging task cannot ready. Supply a verification whose failure is a runner check, or add the debugger with explicit evidence.",
              sourceTaskId: verification.spec.id,
            },
            debugging.spec.id,
          );
        }
      }
    }
  }

  /**
   * Build strict `FailureEvidence` from a failed verification's runtime result.
   * The failing command and exit code come from the runner's failure diagnosis
   * (`"<check> exited <n>"`) or a `runner-check:*` evidence summary; the output
   * artifact is the runner's observed-diff evidence uri. Returns undefined when
   * no reproducible command/exit-code is present — never fabricates a failure.
   */
  private synthesizeFailureEvidence(
    verification: TaskRuntime,
    result: WorkerResult,
  ): FailureEvidence | undefined {
    const parsed = parseFailedRunnerCheck(result);
    if (!parsed) return undefined;
    const sourceWorkerRunId = this.settledWorkerRunIdFor(verification.spec.id);
    const outputArtifact = failureOutputArtifactRef(
      result,
      this.plan.missionId,
      verification.spec.id,
      verification.attempts,
    );
    const evidence: FailureEvidence = {
      sourceTaskId: verification.spec.id,
      // A failed verification always ran at least once; the pull path restores the
      // exact attempt on replay, push-path rehydration falls back to 1.
      sourceAttempt: Math.max(verification.attempts, 1),
      ...(sourceWorkerRunId ? { sourceWorkerRunId } : {}),
      command: parsed.command,
      exitCode: parsed.exitCode,
      outputArtifact,
    };
    return isFailureEvidence(evidence) ? evidence : undefined;
  }

  private settledWorkerRunIdFor(taskId: string): string | undefined {
    for (const [workerRunId, record] of this.settledRuns) {
      if (record.taskId === taskId) return workerRunId;
    }
    return undefined;
  }

  private excludedWorkers(spec: TaskSpec): Set<string> {
    const excluded = new Set<string>();
    if (spec.kind === "verification" && this.doctrine.profile.verification.independentVerifier) {
      for (const dependency of this.allAncestors(spec)) {
        const dependencyTask = this.tasks.get(dependency);
        if (dependencyTask && isWriterTask(dependencyTask.spec)) {
          for (const workerId of dependencyTask.workerIds) excluded.add(workerId);
        }
      }
    }
    const recovery = recoveryMetadata(spec);
    if (recovery && this.doctrine.profile.verification.independentVerifier) {
      const original = this.tasks.get(recovery.failedTaskId);
      // The debugger must be independent from both code-producing and
      // diagnosis-producing attempts. The re-verifier may reuse the original
      // verifier because it remains independent from both writing attempts.
      if (!recovery.debuggerTaskId && original?.workerId) excluded.add(original.workerId);
      for (const dependency of original?.spec.dependsOn ?? []) {
        const implementationWorker = this.tasks.get(dependency)?.workerId;
        if (implementationWorker) excluded.add(implementationWorker);
      }
    }
    return excluded;
  }

  private recoveryPair(record: RecoveryCommandRecord): RecoveryPair {
    return {
      commandId: this.recoveryByFailedTask.get(record.failedTaskId) ?? "unknown",
      failedTaskId: record.failedTaskId,
      debugger: this.getTask(record.debuggerTaskId),
      reverify: this.getTask(record.reverifyTaskId),
      requiredCheckIdentities: [...record.requiredCheckIdentities],
    };
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
    this.statusResolver.ingestDomainEvent(event);
    if (event.type === "task.added") {
      const parsed = TaskSpecSchema.safeParse(event.data.spec);
      if (parsed.success && !recoveryMetadata(parsed.data) && !this.tasks.has(parsed.data.id)) {
        this.tasks.set(parsed.data.id, {
          spec: structuredClone(parsed.data),
          state: "queued",
          attempts: 0,
          workerIds: [],
        });
      }
      return;
    }
    if (event.type === "recovery.pair.added") {
      const recovery = recoveryRecordFromEvent(event);
      if (recovery) {
        const { commandId, debuggerSpec, reverifySpec, ...record } = recovery;
        const existingDebugger = this.tasks.get(debuggerSpec.id);
        const existingReverify = this.tasks.get(reverifySpec.id);
        if (
          (existingDebugger && JSON.stringify(existingDebugger.spec) !== JSON.stringify(debuggerSpec)) ||
          (existingReverify && JSON.stringify(existingReverify.spec) !== JSON.stringify(reverifySpec))
        ) {
          throw new RecoveryConflictError(
            "invalid_recovery",
            `Recovery event ${commandId} conflicts with an existing task`,
          );
        }
        this.tasks.set(debuggerSpec.id, {
          spec: structuredClone(debuggerSpec),
          state: "queued",
          attempts: 0,
          workerIds: [],
        });
        this.tasks.set(reverifySpec.id, {
          spec: structuredClone(reverifySpec),
          state: "queued",
          attempts: 0,
          workerIds: [],
        });
        this.recoveryCommands.set(commandId, record);
        this.recoveryByFailedTask.set(record.failedTaskId, commandId);
      }
      return;
    }
    if (event.type === "task.failure.resolved") {
      const failedTaskId = typeof event.data.failedTaskId === "string" ? event.data.failedTaskId : undefined;
      const reverifyTaskId =
        typeof event.data.reverifyTaskId === "string" ? event.data.reverifyTaskId : undefined;
      if (failedTaskId && reverifyTaskId) this.resolvedFailedTasks.set(failedTaskId, reverifyTaskId);
      return;
    }
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
      this.recordWorkerIdentity(runtime, worker.id);
      runtime.workerHarness = worker.harness;
      runtime.runnerId = runnerId;
      runtime.leaseExpiresAt = leaseExpiresAt;
      runtime.startedAt = event.occurredAt;
      this.assignmentsByClaimId.set(claimId, {
        missionId: this.plan.missionId,
        profileHash: this.plan.profileHash,
        workerRunId: event.workerRunId,
        attempt,
        task: this.taskForWorker(runtime.spec),
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
    if (event.taskId && event.workerRunId) {
      this.replaySemanticEvent(event);
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
      // `task.failed` is a projection event. A preceding canonical settlement
      // already contains the complete evidence and must never be overwritten
      // by the legacy summary-only replay fallback.
      if (runtime && !runtime.result) {
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
    if (
      event.workerRunId &&
      event.type !== "task.started" &&
      event.type !== STATUS_RESOLVED_EVENT_TYPE &&
      event.taskId
    ) {
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

    const excluded = this.excludedWorkers(runtime.spec);

    let worker: WorkerAdapter;
    try {
      worker = router.select(runtime.spec, excluded);
      if (excluded.has(worker.descriptor.id)) {
        throw new Error(
          `Worker router selected excluded worker ${worker.descriptor.id} for verification task ${runtime.spec.id}`,
        );
      }
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
    this.recordWorkerIdentity(runtime, worker.descriptor.id);
    this.verificationStarveSignaled.delete(runtime.spec.id);
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
    this.emit(
      "task.started",
      { title: runtime.spec.title, ...this.verificationStartedEventData(runtime) },
      runtime.spec.id,
      workerRunId,
    );
    this.emitTaskContractStarted(runtime, workerRunId);

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
        task: this.taskForWorker(runtime.spec),
        workspacePath: this.options.workspacePath,
        profileHash: this.plan.profileHash,
        attempt: runtime.attempts,
        signal: abortController.signal,
        emit: (partial) => {
          this.validateWorkerSemanticEvent(runtime, workerRunId, partial.type, partial.data);
          this.emit(partial.type, partial.data, partial.taskId, workerRunId, partial.causationId);
          this.recordWorkerSemanticEvent(workerRunId, partial.type);
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
      this.ingestDebuggerResultEvidence(runtime, workerRunId, result);
      const contractFailure = this.contractFailure(runtime, workerRunId);
      if (contractFailure) {
        runtime.result = {
          ...result,
          status: "failed",
          summary: contractFailure,
          diagnosis: contractFailure,
        };
      }
      runtime.completedAt = this.clock().toISOString();
      runtime.state =
        runtime.result.status === "succeeded"
          ? "succeeded"
          : runtime.result.status === "blocked"
            ? "blocked"
            : "failed";
      this.emit(
        `task.${runtime.state}`,
        {
          summary: runtime.result.summary,
          evidenceCount: runtime.result.evidence.length,
          diagnosis: runtime.result.diagnosis,
          ...this.verificationResultEventData(runtime),
        },
        runtime.spec.id,
        workerRunId,
      );
      this.emit(
        "worker.completed",
        { workerId: worker.descriptor.id, result: runtime.result.status },
        runtime.spec.id,
        workerRunId,
      );
      this.emitTaskContractCompleted(runtime, workerRunId, runtime.result);
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
      this.emitTaskContractCompleted(runtime, workerRunId, runtime.result);
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

  private taskForWorker(spec: TaskSpec): TaskSpec {
    if (spec.kind === "verification") {
      return {
        ...structuredClone(spec),
        metadata: {
          ...spec.metadata,
          [VERIFICATION_CONTRACT_METADATA_KEY]: this.verificationContract(spec),
        },
      };
    }
    return structuredClone(spec);
  }

  private verificationContract(spec: TaskSpec): VerificationContract {
    return {
      acceptanceCriteria: [...spec.successCriteria],
      requiredChecks: [...this.doctrine.profile.verification.requiredChecks],
      unchangedAcceptanceChecks: true,
      huntsCounterexamples: true,
      readOnly: true,
    };
  }

  private emitTaskContractStarted(runtime: TaskRuntime, workerRunId: string): void {
    if (runtime.spec.kind === "debugging") {
      const failure = this.getFailureEvidence(runtime.spec.id);
      if (failure) {
        this.emit(
          "debugger.started",
          {
            sourceTaskId: failure.sourceTaskId,
            sourceAttempt: failure.sourceAttempt,
            command: failure.command,
            exitCode: failure.exitCode,
            outputArtifact: failure.outputArtifact,
            writeScope: [...runtime.spec.writeScope],
            smallestCausalFix: true,
          },
          runtime.spec.id,
          workerRunId,
        );
      }
    }
  }

  private emitTaskContractCompleted(runtime: TaskRuntime, workerRunId: string, result: WorkerResult): void {
    if (runtime.spec.kind === "debugging") {
      const failure = this.getFailureEvidence(runtime.spec.id);
      if (failure) {
        const evidence = this.debuggerEvidenceByRunId.get(workerRunId);
        this.emit(
          result.status === "succeeded" ? "debugger.completed" : "debugger.failed",
          {
            sourceTaskId: failure.sourceTaskId,
            reproduced: evidence?.reproduced ?? false,
            repaired: evidence?.repaired ?? false,
            evidenceCount: result.evidence.length,
          },
          runtime.spec.id,
          workerRunId,
        );
      }
      return;
    }
  }

  private verificationStartedEventData(runtime: TaskRuntime): Record<string, unknown> {
    if (runtime.spec.kind !== "verification") return {};
    const repairedTaskIds = this.allAncestors(runtime.spec)
      .map((taskId) => this.tasks.get(taskId))
      .filter((task): task is TaskRuntime => task?.spec.kind === "debugging")
      .map((task) => task.spec.id);
    const phase = repairedTaskIds.length > 0 ? "reverification" : "initial";
    return {
      verification: {
        phase,
        acceptanceCriteria: [...runtime.spec.successCriteria],
        requiredChecks: [...this.doctrine.profile.verification.requiredChecks],
        unchangedAcceptanceChecks: true,
        huntsCounterexamples: true,
        readOnly: true,
        repairedTaskIds,
      },
    };
  }

  private verificationResultEventData(runtime: TaskRuntime): Record<string, unknown> {
    if (runtime.spec.kind !== "verification") return {};
    const started = this.verificationStartedEventData(runtime).verification;
    return {
      verification: {
        ...(started as Record<string, unknown>),
        resultRecorded: true,
      },
    };
  }

  private allAncestors(spec: TaskSpec): string[] {
    const ancestors: string[] = [];
    const pending = [...spec.dependsOn];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const taskId = pending.pop();
      if (!taskId || seen.has(taskId)) continue;
      seen.add(taskId);
      ancestors.push(taskId);
      pending.push(...(this.tasks.get(taskId)?.spec.dependsOn ?? []));
    }
    return ancestors.sort();
  }

  private dependenciesReady(spec: TaskSpec): boolean {
    return spec.dependsOn.every((dependencyId) => {
      const dependency = this.tasks.get(dependencyId);
      if (!dependency) return false;
      if (dependency.state === "succeeded") return true;
      return (
        spec.kind === "debugging" &&
        dependency.spec.kind === "verification" &&
        dependency.state === "failed" &&
        this.getFailureEvidence(spec.id)?.sourceTaskId === dependencyId
      );
    });
  }

  private recordWorkerIdentity(runtime: TaskRuntime, workerId: string): void {
    if (!runtime.workerIds.includes(workerId)) runtime.workerIds.push(workerId);
  }

  private validateWorkerSemanticEvent(
    runtime: TaskRuntime,
    workerRunId: string,
    type: string,
    data: Record<string, unknown>,
  ): void {
    if (runtime.spec.kind !== "debugging" || runtime.spec.metadata[DEBUGGER_CONTRACT_METADATA_KEY] !== true) {
      return;
    }
    const failure = this.getFailureEvidence(runtime.spec.id);
    if (!failure) throw new Error(`Debugger task ${runtime.spec.id} has no structured failure evidence`);
    if (type === "debugger.reproduced") {
      const reproduction = parseDebuggerReproduction(data);
      if (reproduction.command !== failure.command || reproduction.exitCode !== failure.exitCode) {
        throw new Error(
          `Debugger ${runtime.spec.id} must rerun the exact failing command and exit code from ${failure.sourceTaskId}`,
        );
      }
    }
    if (type === "debugger.repaired") parseRepairArtifacts(data);
    if (type === "debugger.reproduced" || type === "debugger.repaired") {
      const existing = this.debuggerEvidenceByRunId.get(workerRunId) ?? {
        reproduced: false,
        repaired: false,
      };
      if (type === "debugger.reproduced") existing.reproduced = true;
      if (type === "debugger.repaired") existing.repaired = true;
      this.debuggerEvidenceByRunId.set(workerRunId, existing);
    }
  }

  private recordWorkerSemanticEvent(workerRunId: string, type: string): void {
    if (type !== "debugger.reproduced" && type !== "debugger.repaired") return;
    const evidence = this.debuggerEvidenceByRunId.get(workerRunId) ?? { reproduced: false, repaired: false };
    if (type === "debugger.reproduced") evidence.reproduced = true;
    if (type === "debugger.repaired") evidence.repaired = true;
    this.debuggerEvidenceByRunId.set(workerRunId, evidence);
  }

  private ingestDebuggerResultEvidence(
    runtime: TaskRuntime,
    workerRunId: string,
    result: WorkerResult,
  ): void {
    if (runtime.spec.kind !== "debugging" || runtime.spec.metadata[DEBUGGER_CONTRACT_METADATA_KEY] !== true)
      return;
    const raw = result.outputs.debuggerRepair ?? result.outputs.repairEvidence;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const repair = parseDebuggerRepairEvidence(raw);
    const failure = this.getFailureEvidence(runtime.spec.id);
    if (
      !failure ||
      repair.reproduction.command !== failure.command ||
      repair.reproduction.exitCode !== failure.exitCode
    ) {
      throw new Error(`Debugger ${runtime.spec.id} did not reproduce the exact failing check`);
    }
    this.debuggerEvidenceByRunId.set(workerRunId, { reproduced: true, repaired: true });
    this.emit(
      "debugger.reproduced",
      { ...repair.reproduction, sourceTaskId: failure.sourceTaskId },
      runtime.spec.id,
      workerRunId,
    );
    this.emit(
      "debugger.repaired",
      { before: [...repair.before], after: [...repair.after] },
      runtime.spec.id,
      workerRunId,
    );
  }

  private contractFailure(runtime: TaskRuntime, workerRunId: string): string | undefined {
    if (runtime.spec.kind !== "debugging" || runtime.spec.metadata[DEBUGGER_CONTRACT_METADATA_KEY] !== true) {
      return undefined;
    }
    const evidence = this.debuggerEvidenceByRunId.get(workerRunId);
    if (!evidence?.reproduced || !evidence.repaired) {
      return "Debugger result is missing exact-check reproduction and before/after repair evidence.";
    }
    return undefined;
  }

  private replaySemanticEvent(event: DomainEvent): void {
    if (event.type !== "debugger.reproduced" && event.type !== "debugger.repaired") return;
    if (!event.workerRunId) return;
    this.recordWorkerSemanticEvent(event.workerRunId, event.type);
  }

  private emit(
    type: string,
    data: Record<string, unknown>,
    taskId?: string,
    workerRunId?: string,
    causationId?: string,
    eventId?: string,
  ): DomainEvent {
    const event = this.createEvent(type, data, taskId, workerRunId, causationId, eventId);
    this.events.push(event);
    const status = this.statusResolver.ingestDomainEvent(event);
    if (status) {
      this.events.push(
        this.createEvent(
          STATUS_RESOLVED_EVENT_TYPE,
          { ...toResolvedStatusEventData(status) },
          taskId,
          workerRunId,
          event.id,
        ),
      );
    }
    return event;
  }

  private createEvent(
    type: string,
    data: Record<string, unknown>,
    taskId?: string,
    workerRunId?: string,
    causationId?: string,
    eventId?: string,
  ): DomainEvent {
    return {
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
  }
}

function workerEventKey(workerRunId: string, attempt: number, eventId: string): string {
  return `${workerRunId}\0${attempt}\0${eventId}`;
}

function isActiveWorkerTaskState(state: TaskState): boolean {
  return state === "running" || state === "waiting_user";
}

/**
 * A task whose worker changed the candidate, so that worker can never be an
 * independent verifier of a downstream verification task. Any non-empty write
 * scope makes a task a writer regardless of role/kind; the explicit role/kind
 * cases stay for tasks that mutate without declaring a scope.
 */
function isWriterTask(spec: TaskSpec): boolean {
  return (
    spec.writeScope.length > 0 ||
    spec.role === "implementer" ||
    spec.role === "debugger" ||
    spec.kind === "implementation" ||
    spec.kind === "debugging" ||
    spec.kind === "integration"
  );
}

function assertFailureEvidence(value: FailureEvidence): void {
  if (!isFailureEvidence(value)) {
    throw new Error(
      "Failure evidence requires sourceTaskId, positive sourceAttempt, exact command, integer exitCode, and outputArtifact",
    );
  }
}

function isFailureEvidence(value: unknown): value is FailureEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sourceTaskId === "string" &&
    candidate.sourceTaskId.length > 0 &&
    typeof candidate.sourceAttempt === "number" &&
    Number.isInteger(candidate.sourceAttempt) &&
    candidate.sourceAttempt > 0 &&
    (candidate.sourceWorkerRunId === undefined ||
      (typeof candidate.sourceWorkerRunId === "string" && candidate.sourceWorkerRunId.length > 0)) &&
    typeof candidate.command === "string" &&
    candidate.command.length > 0 &&
    typeof candidate.exitCode === "number" &&
    Number.isInteger(candidate.exitCode) &&
    typeof candidate.outputArtifact === "string" &&
    candidate.outputArtifact.length > 0 &&
    candidate.reasoning === undefined &&
    candidate.chainOfThought === undefined &&
    candidate.hiddenReasoning === undefined &&
    candidate.diagnosis === undefined
  );
}

/**
 * Extract the failing command and exit code the runner reported for a failed
 * verification. Prefers the failure diagnosis (`"<check> exited <n>[; ...]"`,
 * the runner's `checks.failures` join), then a `runner-check:*` evidence
 * summary. Returns undefined when the failure carries no reproducible check.
 */
function parseFailedRunnerCheck(result: WorkerResult): { command: string; exitCode: number } | undefined {
  if (typeof result.diagnosis === "string") {
    const fromDiagnosis = matchExited(result.diagnosis);
    if (fromDiagnosis) return fromDiagnosis;
  }
  for (const evidence of result.evidence) {
    if (typeof evidence.label === "string" && evidence.label.startsWith("runner-check:")) {
      const parsed = matchExited(evidence.summary);
      if (parsed) {
        const command = evidence.label.slice("runner-check:".length).trim();
        return { command: command.length > 0 ? command : parsed.command, exitCode: parsed.exitCode };
      }
    }
  }
  return undefined;
}

function matchExited(text: string): { command: string; exitCode: number } | undefined {
  const match = /(.+?)\s+exited\s+(-?\d+)/u.exec(text);
  if (!match) return undefined;
  const command = (match[1] ?? "").trim();
  const exitCode = Number.parseInt(match[2] ?? "", 10);
  if (command.length === 0 || !Number.isInteger(exitCode)) return undefined;
  return { command, exitCode };
}

/**
 * Choose the output artifact for synthesized failure evidence: the runner's
 * observed-diff (or any) evidence uri when present, else a deterministic,
 * non-empty reference to the failed verification attempt.
 */
function failureOutputArtifactRef(
  result: WorkerResult,
  missionId: string,
  taskId: string,
  attempt: number,
): string {
  for (const evidence of result.evidence) {
    if (typeof evidence.uri === "string" && evidence.uri.length > 0) return evidence.uri;
  }
  return `artifact://verification-failure/${missionId}/${taskId}-attempt-${attempt}`;
}

function parseDebuggerReproduction(value: unknown): DebuggerReproductionEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Debugger reproduction evidence must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.command !== "string" ||
    candidate.command.length === 0 ||
    typeof candidate.exitCode !== "number" ||
    !Number.isInteger(candidate.exitCode) ||
    typeof candidate.outputArtifact !== "string" ||
    candidate.outputArtifact.length === 0
  ) {
    throw new Error("Debugger reproduction evidence requires command, integer exitCode, and outputArtifact");
  }
  return {
    command: candidate.command,
    exitCode: candidate.exitCode,
    outputArtifact: candidate.outputArtifact,
  };
}

function parseDebuggerRepairEvidence(value: unknown): DebuggerRepairEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Debugger repair evidence must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const before = candidate.before;
  const after = candidate.after;
  if (
    !Array.isArray(before) ||
    before.length === 0 ||
    !before.every((artifact) => typeof artifact === "string" && artifact.length > 0) ||
    !Array.isArray(after) ||
    after.length === 0 ||
    !after.every((artifact) => typeof artifact === "string" && artifact.length > 0)
  ) {
    throw new Error("Debugger repair evidence requires non-empty before and after artifact references");
  }
  return {
    reproduction: parseDebuggerReproduction(candidate.reproduction),
    before: [...before],
    after: [...after],
  };
}

function parseRepairArtifacts(value: unknown): { before: string[]; after: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Debugger repair evidence must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const before = candidate.before;
  const after = candidate.after;
  if (
    !Array.isArray(before) ||
    before.length === 0 ||
    !before.every((artifact) => typeof artifact === "string" && artifact.length > 0) ||
    !Array.isArray(after) ||
    after.length === 0 ||
    !after.every((artifact) => typeof artifact === "string" && artifact.length > 0)
  ) {
    throw new Error("Debugger repair evidence requires non-empty before and after artifact references");
  }
  return { before: [...before], after: [...after] };
}

const RUNNER_CHECK_IDENTITY_PATTERN = /^runner-check:.+:sha256:[0-9a-f]{64}$/u;

function verificationCheckIdentities(result: WorkerResult): string[] {
  return [
    ...new Set(
      result.evidence
        .filter(
          (evidence) => evidence.kind === "test_report" && RUNNER_CHECK_IDENTITY_PATTERN.test(evidence.label),
        )
        .map((evidence) => evidence.label),
    ),
  ].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function recoveryFingerprint(input: RecoveryPairInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function recoveryMetadata(spec: TaskSpec): { failedTaskId: string; debuggerTaskId?: string } | undefined {
  const value = spec.metadata.recovery;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const failedTaskId = (value as Record<string, unknown>).failedTaskId;
  const debuggerTaskId = (value as Record<string, unknown>).debuggerTaskId;
  return typeof failedTaskId === "string"
    ? {
        failedTaskId,
        ...(typeof debuggerTaskId === "string" ? { debuggerTaskId } : {}),
      }
    : undefined;
}

function recoveryRecordFromEvent(event: DomainEvent):
  | (RecoveryCommandRecord & {
      commandId: string;
      debuggerSpec: TaskSpec;
      reverifySpec: TaskSpec;
    })
  | undefined {
  const { data } = event;
  const debuggerSpec = TaskSpecSchema.safeParse(data.debuggerSpec);
  const reverifySpec = TaskSpecSchema.safeParse(data.reverifySpec);
  if (
    typeof data.commandId !== "string" ||
    typeof data.fingerprint !== "string" ||
    typeof data.failedTaskId !== "string" ||
    typeof data.debuggerTaskId !== "string" ||
    typeof data.reverifyTaskId !== "string" ||
    !Array.isArray(data.requiredCheckIdentities) ||
    !data.requiredCheckIdentities.every((identity) => typeof identity === "string") ||
    !debuggerSpec.success ||
    !reverifySpec.success ||
    data.debuggerTaskId !== debuggerSpec.data.id ||
    data.reverifyTaskId !== reverifySpec.data.id
  ) {
    return undefined;
  }
  return {
    commandId: data.commandId,
    fingerprint: data.fingerprint,
    failedTaskId: data.failedTaskId,
    debuggerTaskId: data.debuggerTaskId,
    reverifyTaskId: data.reverifyTaskId,
    requiredCheckIdentities: data.requiredCheckIdentities,
    debuggerSpec: debuggerSpec.data,
    reverifySpec: reverifySpec.data,
  };
}
