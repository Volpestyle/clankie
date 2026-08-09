import type { DomainEvent, Harness, TaskSpec, WorkerResult, WorkerStatusProvenance } from "@clankie/protocol";

export interface WorkerCapabilities {
  kinds: TaskSpec["kind"][];
  canWrite: boolean;
  supportsStructuredEvents: boolean;
  supportsTerminal: boolean;
  supportsNativeSession: boolean;
}

export interface WorkerDescriptor {
  id: string;
  displayName: string;
  harness: Harness;
  model?: string;
  capabilities: WorkerCapabilities;
}

/**
 * A foreign process that may write in the mission workspace. It is deliberately
 * not a WorkerDescriptor: the runner cannot execute or settle a process it did
 * not launch, but the scheduler must still keep owned writers out of its path.
 */
export interface WorkerScopeReservation {
  id: string;
  workspaceRoot: string;
  writeScope: readonly string[];
}

export interface WorkerRunContext {
  missionId: string;
  workerRunId: string;
  task: TaskSpec;
  workspacePath: string;
  profileHash: string;
  attempt: number;
  signal: AbortSignal;
  emit: (event: Omit<DomainEvent, "id" | "occurredAt" | "correlationId">) => void;
}

export type WorkerSteerSourceLane = "tui" | "discord_text" | "discord_voice" | "api";

/** Server-authenticated authority that requested a finite worker steer intent. */
export type WorkerSteerPrincipal = {
  kind: "captain" | "operator" | "device";
  id: string;
};

export type WorkerSteerIntent =
  | {
      type: "focus";
      target: "current_task" | "failing_test" | "acceptance_criteria" | "scope" | "diagnosis";
    }
  | { type: "continue" }
  | { type: "retry_last_step" }
  | { type: "summarize_status" };

export interface WorkerSteerCommand {
  schemaVersion: 1;
  commandId: string;
  workerRunId: string;
  attempt: number;
  sourceLane: WorkerSteerSourceLane;
  intent: WorkerSteerIntent;
  principal: WorkerSteerPrincipal;
  correlationId: string;
  missionId: string;
  taskId: string;
  profileHash: string;
  input: string;
}

export interface WorkerAdapter {
  readonly descriptor: WorkerDescriptor;
  run(context: WorkerRunContext): Promise<WorkerResult>;
  steer?(runId: string, command: WorkerSteerCommand): Promise<void>;
  cancel?(runId: string): Promise<void>;
}

export type NativeWorkerStatusSource = "codex.app_server" | "claude.agent_sdk" | "pi.rpc";

export function emitWorkerTurnStarted(context: WorkerRunContext, source: NativeWorkerStatusSource): void {
  context.emit({
    type: "worker.turn.started",
    missionId: context.missionId,
    taskId: context.task.id,
    workerRunId: context.workerRunId,
    profileHash: context.profileHash,
    data: { state: "working", ...tierZeroProvenance(source) },
  });
}

export function emitWorkerTurnSettled(context: WorkerRunContext, source: NativeWorkerStatusSource): void {
  context.emit({
    type: "worker.turn.settled",
    missionId: context.missionId,
    taskId: context.task.id,
    workerRunId: context.workerRunId,
    profileHash: context.profileHash,
    data: { state: "idle", ...tierZeroProvenance(source) },
  });
}

export function emitWorkerWaitingUser(
  context: WorkerRunContext,
  source: NativeWorkerStatusSource,
  questionSummary: string,
): void {
  context.emit({
    type: "worker.waiting_user",
    missionId: context.missionId,
    taskId: context.task.id,
    workerRunId: context.workerRunId,
    profileHash: context.profileHash,
    data: {
      state: "waiting_user",
      ...tierZeroProvenance(source),
      questionSummary: questionSummary.trim() || "Worker requires user input.",
    },
  });
}

function tierZeroProvenance(source: NativeWorkerStatusSource): WorkerStatusProvenance {
  return {
    source,
    tier: 0,
    confidence: 1,
    observedAt: new Date().toISOString(),
  };
}

export function cancelledWorkerResult(workerRunId: string, provider: string): WorkerResult {
  return {
    status: "failed",
    summary: `${provider} worker run was cancelled before provider startup.`,
    evidence: [{ kind: "log", label: "worker-cancelled", summary: "Pre-start cancellation observed." }],
    outputs: { workerRunId, nativeSessionId: null },
    diagnosis: "Worker run was already cancelled",
  };
}

/**
 * What the scheduler knows about a task's history when it picks a worker
 * (ADR 0079). Every field is derived from the mission's own event-sourced
 * state, never a wall clock, so the same log always yields the same choice.
 */
export interface WorkerSelectionContext {
  /** Ran a previous attempt of this exact task. */
  previousWorkerId?: string;
  /** Holds a settled assignment whose write scope overlaps this task's. */
  scopeWarmWorkerIds?: ReadonlySet<string>;
  /** Completed a task this one depends on. */
  dependencyWorkerIds?: ReadonlySet<string>;
  /** Currently holds a live assignment. */
  busyWorkerIds?: ReadonlySet<string>;
}

/**
 * Structural eligibility. A preference score can never promote a worker that
 * fails here, which is what keeps affinity from eroding verification
 * independence: the exclusion set is a filter, not a penalty.
 */
export function isWorkerEligible(
  task: TaskSpec,
  descriptor: WorkerDescriptor,
  excludedWorkerIds: ReadonlySet<string> = new Set(),
): boolean {
  if (excludedWorkerIds.has(descriptor.id)) return false;
  if (!descriptor.capabilities.kinds.includes(task.kind)) return false;
  if (task.preferredHarness && descriptor.harness !== task.preferredHarness) return false;
  if (task.writeScope.length > 0 && !descriptor.capabilities.canWrite) return false;
  return true;
}

/**
 * Warmth outranks load, because rebuilding context costs more than waiting for
 * a lane. Weights are spread so no combination of weaker signals outvotes a
 * stronger one — a worker that ran the previous attempt wins over one that is
 * merely idle and scope-warm.
 *
 */
export function scoreWorkerAffinity(
  descriptor: WorkerDescriptor,
  context: WorkerSelectionContext = {},
): number {
  let score = 0;
  if (context.previousWorkerId === descriptor.id) score += 8;
  if (context.scopeWarmWorkerIds?.has(descriptor.id)) score += 4;
  if (context.dependencyWorkerIds?.has(descriptor.id)) score += 2;
  if (!context.busyWorkerIds?.has(descriptor.id)) score += 1;
  return score;
}

/**
 * The one authority for "which worker runs this task", shared by the push and
 * pull paths so they can never disagree. Ties break lexicographically by id:
 * the repository's evidence contracts assume byte-identical reruns, and a
 * scheduler that resolved ties by map order would make identical missions
 * produce different receipts.
 */
export function selectWorkerDescriptor<T extends WorkerDescriptor>(
  task: TaskSpec,
  descriptors: readonly T[],
  excludedWorkerIds: ReadonlySet<string> = new Set(),
  context: WorkerSelectionContext = {},
): T | undefined {
  const eligible = descriptors.filter((descriptor) => isWorkerEligible(task, descriptor, excludedWorkerIds));
  if (eligible.length === 0) return undefined;
  return [...eligible].sort((left, right) => {
    const delta = scoreWorkerAffinity(right, context) - scoreWorkerAffinity(left, context);
    return delta !== 0 ? delta : left.id.localeCompare(right.id);
  })[0];
}

export interface WorkerRouter {
  select(
    task: TaskSpec,
    excludedWorkerIds?: ReadonlySet<string>,
    context?: WorkerSelectionContext,
  ): WorkerAdapter;
}

export class StaticWorkerRouter implements WorkerRouter {
  private readonly workers: WorkerAdapter[];

  public constructor(workers: WorkerAdapter[]) {
    this.workers = workers;
    if (workers.length === 0) throw new Error("At least one worker is required");
  }

  public select(
    task: TaskSpec,
    excludedWorkerIds: ReadonlySet<string> = new Set(),
    context: WorkerSelectionContext = {},
  ): WorkerAdapter {
    const descriptors = this.workers.map((worker) => ({
      ...worker.descriptor,
      adapter: worker,
    }));
    const selected = selectWorkerDescriptor(task, descriptors, excludedWorkerIds, context);
    if (!selected) {
      throw new Error(`No worker can run task ${task.id} (${task.kind})`);
    }
    return selected.adapter;
  }
}
