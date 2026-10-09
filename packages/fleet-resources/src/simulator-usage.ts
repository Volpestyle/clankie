import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { resourceNativeHelperPath, resourcePython } from "./process.ts";

const execute = promisify(execFile);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ProcessSchema = z.strictObject({
  pid: z.number().int().min(2),
  startTime: z.string().min(1).max(128),
  executable: z.string().max(128),
  rssBytes: bytes,
  footprintBytes: bytes,
  cpuTimeMs: z.number().finite().nonnegative(),
});
const ReplySchema = z.strictObject({
  schemaVersion: z.literal(1),
  sampledAtMs: bytes,
  devices: z
    .array(
      z.strictObject({
        deviceId: z.uuid(),
        rootPid: z.number().int().min(2),
        processes: z.array(ProcessSchema).max(10000),
        unavailableProcesses: z.number().int().nonnegative(),
      }),
    )
    .max(256),
});
export interface SimulatorUsage {
  sampledAtMs: number;
  status: "available" | "partial" | "unavailable";
  processCount?: number;
  unavailableProcesses?: number;
  /** Includes shared resident pages; never a physical-memory charge. */
  rssBytes?: number;
  /** Kernel footprint, including private compressed memory; not free-page consumption. */
  footprintBytes?: number;
  cpuTimeMs?: number;
  /** Interval CPU: 100% is one core. Absent until two successful observations. */
  cpuPercent?: number;
  intervalMs?: number;
}
let previous: z.infer<typeof ReplySchema> | undefined;
let cached: { at: number; values: Map<string, SimulatorUsage> } | undefined;
let pending: Promise<Map<string, SimulatorUsage>> | undefined;
/** Diagnostic cache only. Never supplies process, holder, device or release authority. */
export async function observeSimulatorUsage(): Promise<Map<string, SimulatorUsage>> {
  if (process.platform !== "darwin") return new Map();
  if (cached && performance.now() - cached.at < 5000) return cached.values;
  pending ??= (async () => {
    const values = new Map<string, SimulatorUsage>();
    try {
      const { stdout } = await execute(
        resourcePython,
        ["-I", resourceNativeHelperPath(), "simulator-usage"],
        {
          timeout: 3000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
          killSignal: "SIGKILL",
        },
      );
      const reply = ReplySchema.parse(JSON.parse(stdout));
      const intervalMs = previous ? reply.sampledAtMs - previous.sampledAtMs : 0;
      for (const device of reply.devices) {
        const oldDevice = previous?.devices.find(
          (row) => row.deviceId === device.deviceId && row.rootPid === device.rootPid,
        );
        const old = new Map(oldDevice?.processes.map((row) => [`${row.pid}:${row.startTime}`, row]) ?? []);
        let cpuDeltaMs = 0;
        for (const row of device.processes) {
          const last = old.get(`${row.pid}:${row.startTime}`);
          if (last) cpuDeltaMs += Math.max(0, row.cpuTimeMs - last.cpuTimeMs);
          else if (previous && Number(row.startTime) * 1000 >= previous.sampledAtMs)
            cpuDeltaMs += row.cpuTimeMs;
        }
        if (values.has(device.deviceId.toUpperCase())) throw Error("Duplicate simulator usage");
        values.set(device.deviceId.toUpperCase(), {
          sampledAtMs: reply.sampledAtMs,
          status: device.unavailableProcesses ? "partial" : "available",
          processCount: device.processes.length,
          unavailableProcesses: device.unavailableProcesses,
          rssBytes: device.processes.reduce((sum, row) => sum + row.rssBytes, 0),
          footprintBytes: device.processes.reduce((sum, row) => sum + row.footprintBytes, 0),
          cpuTimeMs: device.processes.reduce((sum, row) => sum + row.cpuTimeMs, 0),
          ...(oldDevice && intervalMs > 0 ? { intervalMs, cpuPercent: (cpuDeltaMs / intervalMs) * 100 } : {}),
        });
      }
      previous = reply;
    } catch {
      // An unknown read is not a zero charge, a shutdown receipt or authority to reclaim.
      previous = undefined;
      values.clear();
    }
    cached = { at: performance.now(), values };
    return values;
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}
export function simulatorUsageFor(
  values: ReadonlyMap<string, SimulatorUsage>,
  deviceId: string,
): SimulatorUsage {
  return values.get(deviceId.toUpperCase()) ?? { sampledAtMs: Date.now(), status: "unavailable" };
}
