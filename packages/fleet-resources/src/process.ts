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
