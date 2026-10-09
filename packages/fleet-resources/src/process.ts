import { execFile } from "node:child_process";
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
let pendingMemory: Promise<number> | undefined;
let memoryCache: { at: number; availableMemoryMb: number } | undefined;
/** Shared one-second pressure cache, bounded by free/file-backed pages, never lease authority. */
export async function darwinAvailableMemoryMb(): Promise<number> {
  if (memoryCache && performance.now() - memoryCache.at < 1_000) return memoryCache.availableMemoryMb;
  pendingMemory ??= execute(resourcePython, ["-I", resourceNativeHelperPath(), "memory"], {
    encoding: "utf8",
    timeout: 1_500,
    maxBuffer: 16_384,
    killSignal: "SIGKILL",
  })
    .then(({ stdout }) => {
      const reply: unknown = JSON.parse(stdout);
      if (
        !record(reply) ||
        !keys(reply, ["schemaVersion", "availablePercent", "totalMemoryBytes", "availableMemoryBytes"]) ||
        reply.schemaVersion !== 1 ||
        !integer(reply.availablePercent, 0, 100) ||
        !integer(reply.totalMemoryBytes, 1, Number.MAX_SAFE_INTEGER) ||
        !integer(reply.availableMemoryBytes, 0, reply.totalMemoryBytes as number)
      )
        throw new Error("Darwin memory observation unavailable");
      const availableMemoryMb = reply.availableMemoryBytes / 1024 ** 2;
      memoryCache = { at: performance.now(), availableMemoryMb };
      return availableMemoryMb;
    })
    .finally(() => {
      pendingMemory = undefined;
    });
  return pendingMemory;
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
export interface SimulatorReferents {
  /** Matching processes and their ancestors: PID, parent and executable basename only. */
  readonly processes: ReadonlyMap<number, { readonly ppid: number; readonly executable: string }>;
  /** Needle (UDID or device name) to the PIDs whose arguments contain it. */
  readonly matches: ReadonlyMap<string, readonly number[]>;
}
/** Which of this user's live processes name a simulator. Arguments never leave the helper. */
export async function observeSimulatorReferents(needles: readonly string[]): Promise<SimulatorReferents> {
  const requested = [...new Set(needles)];
  if (requested.length === 0) return { processes: new Map(), matches: new Map() };
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      resourcePython,
      ["-I", resourceNativeHelperPath(), "simulator-referents"],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 4_194_304, killSignal: "SIGKILL" },
      (error, output) => (error ? reject(error) : resolve(output)),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ needles: requested }));
  });
  const reply: unknown = JSON.parse(stdout);
  if (
    !record(reply) ||
    !keys(reply, ["schemaVersion", "processes", "matches"]) ||
    reply.schemaVersion !== 1 ||
    !Array.isArray(reply.processes) ||
    !record(reply.matches)
  )
    throw new Error("Simulator referents unavailable");
  const processes = new Map<number, { ppid: number; executable: string }>();
  for (const row of reply.processes) {
    if (
      !record(row) ||
      !keys(row, ["pid", "ppid", "executable"]) ||
      !integer(row.pid, 2, 2_147_483_647) ||
      !integer(row.ppid, 0, 2_147_483_647) ||
      !text(row.executable)
    )
      throw new Error("Simulator referents unavailable");
    processes.set(row.pid, { ppid: row.ppid, executable: row.executable });
  }
  const matches = new Map<string, number[]>();
  for (const [needle, pids] of Object.entries(reply.matches)) {
    if (
      !requested.includes(needle) ||
      !Array.isArray(pids) ||
      !pids.every((pid) => integer(pid, 2, 2_147_483_647) && processes.has(pid))
    )
      throw new Error("Simulator referents unavailable");
    matches.set(needle, pids as number[]);
  }
  return { processes, matches };
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
