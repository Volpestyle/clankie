import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
const identifier = z
  .string()
  .regex(/^com\.apple\.CoreSimulator\.(?:SimDeviceType|SimRuntime)\.[A-Za-z0-9.-]{1,160}$/u);
const NativeDeviceSchema = z.object({
  udid: uuid,
  name: z.string().min(1).max(512),
  state: z.string().min(1).max(64),
  isAvailable: z.boolean(),
  deviceTypeIdentifier: z.string().max(256).optional(),
});
const InventorySchema = z.object({ devices: z.record(z.string(), z.array(NativeDeviceSchema)) });

export interface SimulatorDevice {
  readonly udid: string;
  readonly name: string;
  readonly runtime: string;
  readonly state: string;
  readonly available: boolean;
  readonly deviceType?: string;
}
export interface SimulatorAdapter {
  inventory(): Promise<readonly SimulatorDevice[]>;
  create(name: string, deviceType: string, runtime: string): Promise<string>;
  boot(udid: string): Promise<void>;
  shutdown(udid: string): Promise<void>;
  delete(udid: string): Promise<void>;
}
/** Injection replaces only the executable boundary; fixtures use real child processes. */
export type SimctlRun = (args: readonly string[], timeoutMs: number) => Promise<string>;

export function createSimctlAdapter(input: { run?: SimctlRun } = {}): SimulatorAdapter {
  const run: SimctlRun =
    input.run ??
    (async (args, timeoutMs) => {
      if (process.platform !== "darwin") throw new Error("CoreSimulator requires macOS");
      const result = await execute("/usr/bin/xcrun", ["simctl", ...args], {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      });
      return result.stdout;
    });
  const exactDevice = (udid: string) => uuid.parse(udid);
  return {
    async inventory() {
      const value = InventorySchema.parse(JSON.parse(await run(["list", "devices", "--json"], 15_000)));
      const devices: SimulatorDevice[] = [];
      const seen = new Set<string>();
      for (const [runtime, rows] of Object.entries(value.devices)) {
        for (const row of rows) {
          const udid = row.udid.toUpperCase();
          if (seen.has(udid)) throw new Error("CoreSimulator inventory contains duplicate identities");
          seen.add(udid);
          devices.push({
            udid,
            name: row.name,
            runtime,
            state: row.state,
            available: row.isAvailable,
            ...(row.deviceTypeIdentifier ? { deviceType: row.deviceTypeIdentifier } : {}),
          });
        }
      }
      return devices;
    },
    async create(name, deviceType, runtime) {
      const label = z
        .string()
        .regex(/^Clankie-[a-f0-9-]{36}$/u)
        .parse(name);
      identifier.parse(deviceType);
      identifier.parse(runtime);
      if (
        !deviceType.startsWith("com.apple.CoreSimulator.SimDeviceType.") ||
        !runtime.startsWith("com.apple.CoreSimulator.SimRuntime.")
      )
        throw new Error("Explicit simulator type and runtime are required");
      return exactDevice((await run(["create", label, deviceType, runtime], 30_000)).trim()).toUpperCase();
    },
    async boot(udid) {
      await run(["bootstatus", exactDevice(udid), "-b"], 120_000);
    },
    async shutdown(udid) {
      await run(["shutdown", exactDevice(udid)], 30_000);
    },
    async delete(udid) {
      await run(["delete", exactDevice(udid)], 30_000);
    },
  };
}
