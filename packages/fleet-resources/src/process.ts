import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProcessIdentity, ProcessProof } from "./model.ts";

const execute = promisify(execFile);
export const resourcePython = process.platform === "darwin" ? "/usr/bin/python3" : "python3";
/** Source modules and installed entrypoints share the bounded repo-shaped helper path. */
export function resourceNativeHelperPath(): string {
  const roots = [import.meta.dirname, process.argv[1] ? dirname(resolve(process.argv[1])) : undefined];
  for (const root of roots) {
    if (!root) continue;
    if (existsSync(join(root, "native.py"))) return join(root, "native.py");
    let ancestor = root;
    for (let depth = 0; depth < 8; depth++) {
      const path = join(ancestor, "packages/fleet-resources/src/native.py");
      if (existsSync(path)) return path;
      const next = dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
  }
  throw new Error("Fleet resource native helper is missing; repair this Clankie install");
}
/** Verify the observer's own identity, independently of a service running as PID 1. */
export async function nativeBoundaryAvailable(): Promise<boolean> {
  const { stdout } = await execute(resourcePython, ["-I", resourceNativeHelperPath(), "available"], {
    encoding: "utf8",
    timeout: 3_000,
    maxBuffer: 16_384,
  });
  return JSON.parse(stdout) === true;
}
/** Undefined means proved absence; uncertain native reads reject and retain leases. */
export async function processIdentity(pid = process.pid): Promise<ProcessIdentity | undefined> {
  const { stdout } = await execute(
    resourcePython,
    ["-I", resourceNativeHelperPath(), "identity", String(pid)],
    { encoding: "utf8", timeout: 3_000, maxBuffer: 16_384 },
  );
  return (JSON.parse(stdout) as ProcessIdentity | null) ?? undefined;
}
export async function probeProcess(proof: ProcessProof): Promise<"live" | "exited" | "unknown"> {
  try {
    const current = await processIdentity(proof.pid);
    if (!current) return "exited";
    return current.startTime === proof.startTime || current.legacyStartTime === proof.startTime
      ? "live"
      : "exited";
  } catch {
    return "unknown";
  }
}
type ProcessObservation = { status: "live"; identity: ProcessIdentity } | { status: "exited" | "unknown" };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/\p{Cc}/u.test(value);
}
function identityReply(value: unknown): ProcessIdentity | undefined {
  if (
    !record(value) ||
    !keys(value, ["pid", "startTime", "pgid", "ppid", "uid"], ["legacyStartTime"]) ||
    !integer(value.pid, 2, 2_147_483_647) ||
    !text(value.startTime) ||
    !integer(value.pgid, 1, 2_147_483_647) ||
    !integer(value.ppid, 0, 2_147_483_647) ||
    !integer(value.uid, 0, 4_294_967_295) ||
    (value.legacyStartTime !== undefined && !text(value.legacyStartTime))
  )
    return undefined;
  return {
    pid: value.pid,
    startTime: value.startTime,
    pgid: value.pgid,
    ppid: value.ppid,
    uid: value.uid,
    ...(value.legacyStartTime === undefined ? {} : { legacyStartTime: value.legacyStartTime as string }),
  };
}
/** One fresh bounded observation of exact journal PIDs; omissions never prove exit. */
export async function observeProcesses(pids: readonly number[]): Promise<Map<number, ProcessObservation>> {
  const requested = [...new Set(pids)];
  const unknown = () =>
    new Map<number, ProcessObservation>(requested.map((pid) => [pid, { status: "unknown" }]));
  if (requested.length > 640 || !requested.every((pid) => integer(pid, 2, 2_147_483_647))) return unknown();
  if (requested.length === 0) return unknown();
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        resourcePython,
        ["-I", resourceNativeHelperPath(), "observe"],
        {
          encoding: "utf8",
          timeout: 3_000,
          maxBuffer: 1_048_576,
          killSignal: "SIGKILL",
        },
        (error, output) => (error ? reject(error) : resolve(output)),
      );
      // A failed helper can close this private request pipe before its exit receipt.
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify({ pids: requested }));
    });
    const reply: unknown = JSON.parse(stdout);
    if (
      !record(reply) ||
      !keys(reply, ["schemaVersion", "observations"]) ||
      reply.schemaVersion !== 1 ||
      !Array.isArray(reply.observations) ||
      reply.observations.length > requested.length
    )
      return unknown();
    const result = unknown(),
      seen = new Set<number>();
    for (const row of reply.observations) {
      if (!record(row) || !integer(row.pid, 2, 2_147_483_647) || !result.has(row.pid) || seen.has(row.pid))
        return unknown();
      seen.add(row.pid);
      if (row.status === "live" && keys(row, ["pid", "status", "identity"])) {
        const identity = identityReply(row.identity);
        if (!identity || identity.pid !== row.pid) return unknown();
        result.set(row.pid, { status: "live", identity });
      } else if ((row.status === "exited" || row.status === "unknown") && keys(row, ["pid", "status"])) {
        result.set(row.pid, { status: row.status });
      } else return unknown();
    }
    return result;
  } catch {
    return unknown();
  }
}
let pendingSnapshot: Promise<ProcessIdentity[]> | undefined;
let snapshotCache: { at: number; rows: ProcessIdentity[] } | undefined;
export async function processSnapshot(): Promise<ProcessIdentity[]> {
  if (snapshotCache && Date.now() - snapshotCache.at < 250) return snapshotCache.rows;
  if (pendingSnapshot) return pendingSnapshot;
  pendingSnapshot = execute(resourcePython, ["-I", resourceNativeHelperPath(), "snapshot"], {
    encoding: "utf8",
    timeout: 3_000,
    maxBuffer: 2_000_000,
  })
    .then(({ stdout }) => {
      const rows = JSON.parse(stdout) as ProcessIdentity[];
      if (!Array.isArray(rows) || rows.length > 10_000) throw new Error("Fleet process snapshot unavailable");
      snapshotCache = { at: Date.now(), rows };
      return rows;
    })
    .finally(() => {
      pendingSnapshot = undefined;
    });
  return pendingSnapshot;
}
export { spawn };
