import type {
  DomainEvent,
  Harness,
  TaskSpec,
  WorkerAdoptionGrade,
  WorkerResult,
  WorkerStatusProvenance,
} from "@clankie/protocol";

export interface WorkerCapabilities {
  kinds: TaskSpec["kind"][];
  canWrite: boolean;
  supportsStructuredEvents: boolean;
  supportsTerminal: boolean;
  supportsNativeSession: boolean;
}

/**
 * Present only on a worker the runner did not start (ADR 0078). Its declared
 * write scope is what the adopter promised on its behalf, and it is the reason
 * an adopted worker can participate in path-collision checks at all.
 */
export interface WorkerAdoptionFacts {
  grade: WorkerAdoptionGrade;
  writeScope: readonly string[];
}

export interface WorkerDescriptor {
  id: string;
  displayName: string;
  harness: Harness;
  model?: string;
  capabilities: WorkerCapabilities;
  adoption?: WorkerAdoptionFacts;
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
  if (descriptor.adoption) {
    // Knowledge-only adoptions are not workers, and no adopted worker may be
    // the verifier of record: the runner cannot attest to an environment it
    // did not build (ADR 0078).
    if (descriptor.adoption.grade !== "directed") return false;
    if (task.kind === "verification" || task.kind === "review") return false;
  }
  return true;
}

/** Maximum warmth-and-load score, used to size the adoption penalty. */
const MAX_AFFINITY_SCORE = 8 + 4 + 2 + 1;

/**
 * Warmth outranks load, because rebuilding context costs more than waiting for
 * a lane. Weights are spread so no combination of weaker signals outvotes a
 * stronger one — a worker that ran the previous attempt wins over one that is
 * merely idle and scope-warm.
 *
 * Adoption is a penalty larger than every warmth signal combined, so a spawned
 * worker always beats an adopted one when both are eligible. Adoption is a
 * fallback, not a preference: an adopted worker runs in an environment the
 * runner never built and drags a mandatory external verification behind it, so
 * borrowing one when an owned worker is free is a strictly worse trade. The
 * case where an adopted worker *must* be used — it holds the write scope — is
 * a hard filter upstream, not something this score is asked to express.
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
  if (descriptor.adoption) score -= MAX_AFFINITY_SCORE + 1;
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
