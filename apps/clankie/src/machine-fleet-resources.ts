import { availableParallelism, totalmem } from "node:os";
import {
  FleetMachineResourceSnapshotSchema,
  FleetResourceMachineIdSchema,
  FleetResourcePolicySchema,
  resolveFleetResourcePolicy,
  type FleetMachineResourceSnapshot,
  type FleetResourceMachineSpecs,
  type FleetResourcePolicy,
  type FleetResourceSnapshot,
} from "@clankie/protocol";
import type { ClankieSettings } from "@clankie/settings";
import type { FleetResourceRuntime } from "./fleet-resource-runtime.ts";

/** A linked host governor supplies these observations through its own bounded transport. */
export interface RemoteFleetResourceHost {
  status(
    machine: string,
    signal?: AbortSignal,
  ): Promise<
    { machine: string; specs: FleetResourceMachineSpecs; snapshot: FleetResourceSnapshot } | undefined
  >;
  configure(machine: string, policy: FleetResourcePolicy, signal?: AbortSignal): Promise<void>;
}
async function remoteCall<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Machine resource request timed out");
          controller.abort(error);
          reject(error);
        }, 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export function resourceMachine(settings: ClankieSettings, selector: string): string {
  const id = selector === "default" ? "local" : FleetResourceMachineIdSchema.parse(selector);
  if (id !== "local" && !settings.machines.some((machine) => machine.id === id))
    throw new Error("Unknown resource machine");
  return id;
}
export function machineResourcePolicy(settings: ClankieSettings, machine: string): FleetResourcePolicy {
  const overrides = settings.fleet.machineResources;
  return overrides && Object.hasOwn(overrides, machine)
    ? overrides[machine]!
    : FleetResourcePolicySchema.parse(machine === "local" ? (settings.fleet.resources ?? {}) : {});
}
export function createMachineFleetResources(input: {
  settings(): Promise<ClankieSettings>;
  local?: FleetResourceRuntime | undefined;
  remote?: RemoteFleetResourceHost | undefined;
}) {
  return {
    async status(selector: string): Promise<FleetMachineResourceSnapshot> {
      const settings = await input.settings();
      const machine = resourceMachine(settings, selector);
      const policy = machineResourcePolicy(settings, machine);
      const unavailable = (
        reason: "governor-unavailable" | "probe-unavailable",
      ): FleetMachineResourceSnapshot => ({
        schemaVersion: 1,
        machine,
        policy,
        status: "unavailable",
        reason,
      });
      if (machine === "local") {
        const snapshot = input.local?.status();
        if (!snapshot) return unavailable("governor-unavailable");
        const platform = process.platform;
        if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
          return unavailable("probe-unavailable");
        return FleetMachineResourceSnapshotSchema.parse({
          schemaVersion: 1,
          machine,
          policy,
          status: "available",
          specs: { platform, cores: availableParallelism(), memoryBytes: totalmem() },
          snapshot,
        });
      }
      try {
        const host = input.remote
          ? await remoteCall((signal) => input.remote!.status(machine, signal))
          : undefined;
        if (!host) return unavailable("governor-unavailable");
        if (host.machine !== machine) return unavailable("probe-unavailable");
        return FleetMachineResourceSnapshotSchema.parse({
          schemaVersion: 1,
          machine,
          policy,
          status: "available",
          specs: host.specs,
          snapshot: host.snapshot,
        });
      } catch {
        return unavailable("probe-unavailable");
      }
    },
    async configure(selector: string): Promise<void> {
      const settings = await input.settings();
      const machine = resourceMachine(settings, selector);
      const policy = machineResourcePolicy(settings, machine);
      if (machine === "local") {
        await input.local?.configure(policy);
        return;
      }
      // An offline host keeps its desired policy without inventing its capacity.
      const status = await this.status(machine);
      if (status.status === "available" && input.remote)
        await remoteCall((signal) =>
          input.remote!.configure(machine, resolveFleetResourcePolicy(policy, status.specs), signal),
        );
    },
  };
}
