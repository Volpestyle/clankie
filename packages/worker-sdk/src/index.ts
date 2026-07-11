import type { DomainEvent, Harness, TaskSpec, WorkerResult } from "@sapling/protocol";

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
  task: TaskSpec;
  workspacePath: string;
  profileHash: string;
  attempt: number;
  signal: AbortSignal;
  emit: (event: Omit<DomainEvent, "id" | "occurredAt" | "correlationId">) => void;
}

export interface WorkerAdapter {
  readonly descriptor: WorkerDescriptor;
  run(context: WorkerRunContext): Promise<WorkerResult>;
  steer?(runId: string, input: string): Promise<void>;
  cancel?(runId: string): Promise<void>;
}

export interface WorkerRouter {
  select(task: TaskSpec, excludedWorkerIds?: ReadonlySet<string>): WorkerAdapter;
}

export class StaticWorkerRouter implements WorkerRouter {
  public constructor(private readonly workers: WorkerAdapter[]) {
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
