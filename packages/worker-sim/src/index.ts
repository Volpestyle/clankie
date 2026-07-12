import type { Harness, TaskKind, WorkerResult } from "@clankie/protocol";
import { cancelledWorkerResult, type WorkerAdapter, type WorkerRunContext } from "@clankie/worker-sdk";

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
        // No provider-native session: a simulated worker has no external
        // provider (Codex thread, Claude session, Pi session) to bind, resume,
        // or steer. `supportsNativeSession` means "has a provider-native
        // session", so it stays false. A runner sim handler may bind a
        // synthetic `sim:<workerRunId>` id for evidence correlation, but that
        // id is runner-owned and derived from the workerRunId the runner
        // already holds — it is not a provider-native session and does not
        // change this flag. Consumers keying on `supportsNativeSession` (e.g.
        // to decide whether provider-native session lifecycle applies) must
        // read false for simulated workers.
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
