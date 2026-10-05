import { ChildProcess } from "node:child_process";
import { basename } from "node:path";

export interface SpawnRecord {
  command: string;
  kind: string;
  started: boolean;
  overlappingKinds: string[];
}
/** Observe actual ChildProcess dispatches, including promisified execFile. */
export function countProofSpawns() {
  const prototype = ChildProcess.prototype as unknown as { spawn(...args: unknown[]): unknown };
  const original = prototype.spawn;
  let active: SpawnRecord[] | undefined;
  const running = new Set<SpawnRecord>();
  prototype.spawn = function (this: ChildProcess, ...args: unknown[]) {
    const options = args[0] as { file: string; args?: string[] };
    if (active) {
      const command = basename(options.file);
      const kind =
        command === "herdr"
          ? `herdr:${options.args?.[1]}`
          : options.args?.includes("--processes")
            ? "native:processes"
            : command.includes("fleet-proof") || command === "native-process-proof"
              ? "native:socket"
              : command;
      const record = {
        command,
        kind,
        started: false,
        overlappingKinds: [...running].map((record) => record.kind),
      };
      active.push(record);
      running.add(record);
      this.once("close", () => running.delete(record));
      this.once("spawn", () => {
        record.started = true;
      });
    }
    return Reflect.apply(original, this, args);
  };
  return {
    async measure<T>(action: () => Promise<T>) {
      if (active || running.size !== 0) throw new Error("Overlapping proof measurement");
      const records: SpawnRecord[] = [];
      active = records;
      const began = performance.now();
      try {
        return { value: await action(), elapsedMs: performance.now() - began, records };
      } finally {
        active = undefined;
      }
    },
    close() {
      prototype.spawn = original;
    },
  };
}
