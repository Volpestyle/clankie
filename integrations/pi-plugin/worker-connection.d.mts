import type { PiWorkerRuntime } from "./worker-runtime.mjs";
export function connectPiWorker(
  input: { port: number; token: string },
  createRuntime: (controller: unknown) => PiWorkerRuntime,
): { close(): void };
