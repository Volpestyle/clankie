import type { Harness, TaskKind, WorkerResult } from "@sapling/protocol";
import { cancelledWorkerResult, type WorkerAdapter, type WorkerRunContext } from "@sapling/worker-sdk";

export type SimulatedTaskHandler = (context: WorkerRunContext) => Promise<WorkerResult> | WorkerResult;

export interface SimulatedWorkerOptions {
  id: string;
  displayName?: string;
  harness?: Harness;
  kinds: TaskKind[];
  canWrite?: boolean;
  handlers: Partial<Record<TaskKind, SimulatedTaskHandler>>;
  defaultHandler?: SimulatedTaskHandler;
  latencyMs?: number;
}

export class SimulatedWorkerAdapter implements WorkerAdapter {
  public readonly descriptor;

  private readonly options: SimulatedWorkerOptions;

  public constructor(options: SimulatedWorkerOptions) {
    this.options = options;
    this.descriptor = {
      id: options.id,
      displayName: options.displayName ?? options.id,
      harness: options.harness ?? "simulated",
      capabilities: {
        kinds: options.kinds,
        canWrite: options.canWrite ?? false,
        supportsStructuredEvents: true,
        supportsTerminal: false,
        supportsNativeSession: false,
      },
    };
  }

  public async run(context: WorkerRunContext): Promise<WorkerResult> {
    if (context.signal.aborted) return cancelledWorkerResult(context.workerRunId, "Simulated");
    if (this.options.latencyMs) {
      await new Promise<void>((resolve, reject) => {
        const complete = () => {
          context.signal.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(complete, this.options.latencyMs);
        const abort = () => {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", abort);
          reject(new Error("Simulated worker aborted"));
        };
        context.signal.addEventListener("abort", abort, { once: true });
      });
    }

    context.emit({
      type: "worker.progress",
      missionId: context.missionId,
      taskId: context.task.id,
      workerRunId: context.workerRunId,
      profileHash: context.profileHash,
      data: { message: `${this.descriptor.displayName} started ${context.task.title}` },
    });

    const handler = this.options.handlers[context.task.kind] ?? this.options.defaultHandler;
    if (!handler) {
      return {
        status: "failed",
        summary: `No simulated handler for ${context.task.kind}.`,
        evidence: [],
        outputs: { workerRunId: context.workerRunId },
      };
    }
    const result = await handler(context);
    return { ...result, outputs: { ...result.outputs, workerRunId: context.workerRunId } };
  }
}
