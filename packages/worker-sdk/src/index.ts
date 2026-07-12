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
  principal: { kind: "captain" | "operator"; id: string };
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

export interface WorkerRouter {
  select(task: TaskSpec, excludedWorkerIds?: ReadonlySet<string>): WorkerAdapter;
}

export class StaticWorkerRouter implements WorkerRouter {
  private readonly workers: WorkerAdapter[];

  public constructor(workers: WorkerAdapter[]) {
    this.workers = workers;
    if (workers.length === 0) throw new Error("At least one worker is required");
  }

  public select(task: TaskSpec, excludedWorkerIds: ReadonlySet<string> = new Set()): WorkerAdapter {
    const candidates = this.workers.filter(
      (worker) =>
        !excludedWorkerIds.has(worker.descriptor.id) &&
        worker.descriptor.capabilities.kinds.includes(task.kind) &&
        (!task.preferredHarness || worker.descriptor.harness === task.preferredHarness),
    );
    const selected = candidates[0];
    if (!selected) {
      throw new Error(`No worker can run task ${task.id} (${task.kind})`);
    }
    return selected;
  }
}
