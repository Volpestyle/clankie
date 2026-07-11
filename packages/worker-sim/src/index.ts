import type { Harness, TaskKind, WorkerResult } from "@sapling/protocol";
import type { WorkerAdapter, WorkerRunContext } from "@sapling/worker-sdk";

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

  public constructor(private readonly options: SimulatedWorkerOptions) {
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
    if (this.options.latencyMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.latencyMs);
        context.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Simulated worker aborted"));
          },
          { once: true },
        );
      });
    }

    context.emit({
      type: "worker.progress",
      missionId: context.missionId,
      taskId: context.task.id,
      profileHash: context.profileHash,
      data: { message: `${this.descriptor.displayName} started ${context.task.title}` },
    });

    const handler = this.options.handlers[context.task.kind] ?? this.options.defaultHandler;
    if (!handler) {
      return {
        status: "failed",
        summary: `No simulated handler for ${context.task.kind}.`,
        evidence: [],
        outputs: {},
      };
    }
    return handler(context);
  }
}
