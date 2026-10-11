import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ProcessIdentity, ProcessProof } from "./model.ts";

/**
 * One native helper read. A timeout is uncertainty, which refuses admission,
 * so this is sized for a cold Python start on a loaded machine: the first
 * `native.py identity` on a clean macOS CI runner took 5.5 s (VUH-2059), and
 * three simulator cases there failed at the earlier 3 s limit (about 3,030 ms). Warm reads take
 * about 0.1 s.
 */
const helperTimeoutMs = 10_000;
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
/**
 * One long-lived native observer per process (VUH-2082). Every observation
 * used to start its own Python, 150-210 per FIFO test case and one per waiter
 * pass on the live machine. Requests carry an id; a timeout or a dead helper
 * fails every pending request, which callers already treat as unknown, and
 * the next request starts a fresh helper. Idle, it never keeps a process alive,
 * and it exits when its parent closes the pipe.
 */
type ObserverRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
let observer: { child: ChildProcess; pending: Map<number, ObserverRequest> } | undefined;
let nextRequest = 1;
function hold(child: ChildProcess, busy: boolean) {
  for (const handle of [child, child.stdin, child.stdout] as ({ ref?(): void; unref?(): void } | null)[])
    if (busy) handle?.ref?.();
    else handle?.unref?.();
}
function nativeObserver() {
  if (observer) return observer;
  // Its own process group: never a member of the caller's (a heavy runner's
  // leftovers or occupancy) and never sent the caller's group signals.
  const child = spawn(resourcePython, ["-I", resourceNativeHelperPath(), "serve"], {
    stdio: ["pipe", "pipe", "ignore"],
    detached: true,
  });
  const current = { child, pending: new Map<number, ObserverRequest>() };
  const fail = (reason: string) => {
    if (observer === current) observer = undefined;
    for (const request of current.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    current.pending.clear();
  };
  child.once("error", () => fail("Fleet resource native observer could not start; Python 3 is required"));
  child.once("exit", () => fail("Fleet resource native observer exited"));
  child.stdin?.on("error", () => {});
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let reply: unknown;
    try {
      reply = JSON.parse(line);
    } catch {
      reply = undefined;
    }
    const request = record(reply) && typeof reply.id === "number" ? current.pending.get(reply.id) : undefined;
    if (!record(reply) || !request) {
      // An unmatched reply means the stream is out of step; nothing it says can be trusted.
      child.kill("SIGKILL");
      return;
    }
    current.pending.delete(reply.id as number);
    clearTimeout(request.timer);
    if (current.pending.size === 0) hold(child, false);
    if ("error" in reply) request.reject(new Error("Fleet resource native observation failed"));
    else request.resolve(reply.result);
  });
  observer = current;
  hold(child, false);
  return current;
}
function observe(op: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const current = nativeObserver();
  const id = nextRequest++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      current.pending.delete(id);
      reject(new Error("Fleet resource native observation timed out"));
      // Later replies would be out of step; start over with a fresh helper.
      current.child.kill("SIGKILL");
    }, timeoutMs);
    current.pending.set(id, { resolve, reject, timer });
    hold(current.child, true);
    current.child.stdin?.write(`${JSON.stringify({ id, op, ...payload })}\n`);
  });
}
/** Verify the observer's own identity, independently of a service running as PID 1. */
export async function nativeBoundaryAvailable(): Promise<boolean> {
  return (await observe("available", {}, helperTimeoutMs)) === true;
}
let pendingMemory: Promise<number> | undefined;
let memoryCache: { at: number; availableMemoryMb: number } | undefined;
/** Shared one-second pressure cache, bounded by free/file-backed pages, never lease authority. */
export async function darwinAvailableMemoryMb(): Promise<number> {
  if (memoryCache && performance.now() - memoryCache.at < 1_000) return memoryCache.availableMemoryMb;
  pendingMemory ??= observe("memory", {}, 1_500)
    .then((reply) => {
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
  return ((await observe("identity", { pid }, helperTimeoutMs)) as ProcessIdentity | null) ?? undefined;
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
    const reply = await observe("observe", { pids: requested }, helperTimeoutMs);
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
  pendingSnapshot = observe("snapshot", {}, helperTimeoutMs)
    .then((reply) => {
      const rows = reply as ProcessIdentity[];
      if (!Array.isArray(rows) || rows.length > 10_000) throw new Error("Fleet process snapshot unavailable");
      snapshotCache = { at: Date.now(), rows };
      return rows;
    })
    .finally(() => {
      pendingSnapshot = undefined;
    });
  return pendingSnapshot;
}

/** Count occupancy only, across all UIDs; this is never signal authority. */
export async function processGroupOccupied(pgid: number): Promise<boolean> {
  const occupied = await observe("group-occupied", { pgid }, 5_000);
  if (typeof occupied !== "boolean") throw new Error("Process group observation unavailable");
  return occupied;
}
