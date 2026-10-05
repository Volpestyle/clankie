import { ChildProcess } from "node:child_process";
import { basename } from "node:path";
export function frequencySpawns() {
  const prototype = ChildProcess.prototype as unknown as { spawn(...args: unknown[]): unknown };
  const original = prototype.spawn;
  const records: {
    at: number;
    command: string;
    kind: string;
    pid?: number;
    started: boolean;
    closedAt?: number;
  }[] = [];
  const persistent = new Set<ChildProcess>();
  prototype.spawn = function (this: ChildProcess, ...args: unknown[]) {
    const options = args[0] as { file: string; args?: string[] };
    const command = basename(options.file);
    const kind = options.args?.includes("--serve")
      ? "native:serve"
      : options.args?.includes("--processes")
        ? "native:processes"
        : command === "herdr"
          ? `herdr:${options.args?.[1]}`
          : command;
    const record: (typeof records)[number] = { at: performance.now(), command, kind, started: false };
    records.push(record);
    if (kind === "native:serve") persistent.add(this);
    this.once("spawn", () => {
      record.started = true;
      if (this.pid !== undefined) record.pid = this.pid;
    });
    this.once("close", () => {
      record.closedAt = performance.now();
      persistent.delete(this);
    });
    return Reflect.apply(original, this, args);
  };
  return {
    records,
    persistent,
    close() {
      prototype.spawn = original;
    },
  };
}
