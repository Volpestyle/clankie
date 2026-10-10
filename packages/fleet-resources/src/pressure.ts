import { readFile } from "node:fs/promises";
import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";
import type { FleetResourcePolicy, ResourcePressure, ResourcePressureInput } from "./model.ts";
import { darwinAvailableMemoryMb, nativeBoundaryAvailable } from "./process.ts";
import { heavyJobParallelism } from "./parallelism.ts";

/** OS available-memory estimate in MiB, including reclaimable/compressible memory. */
async function availableMemoryMb(): Promise<number> {
  if (process.platform === "darwin") return darwinAvailableMemoryMb();
  if (process.platform === "linux") {
    // The kernel's own estimate of memory available without swapping.
    const meminfo = await readFile("/proc/meminfo", "utf8");
    const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1];
    if (kb !== undefined) return Number(kb) / 1024;
  }
  return freemem() / 1024 ** 2;
}

let nativeAvailable = false;
let nativePending: Promise<void> | undefined;
let nativeFailedAt = 0;
async function defaultProbe(): Promise<ResourcePressureInput> {
  if (!nativeAvailable) {
    if (nativeFailedAt && Date.now() - nativeFailedAt < 5_000)
      throw new Error("Fleet native boundary unavailable");
    nativePending ??= nativeBoundaryAvailable()
      .then((available) => {
        if (!available) throw new Error("Fleet native boundary unavailable");
        nativeAvailable = true;
      })
      .catch(() => {
        nativeFailedAt = Date.now();
        throw new Error("Fleet native boundary unavailable");
      })
      .finally(() => {
        nativePending = undefined;
      });
    await nativePending;
  }
  const cpuRatio = busyCpuRatio();
  return {
    loadRatio: loadavg()[0]! / Math.max(1, availableParallelism()),
    ...(cpuRatio === undefined ? {} : { cpuRatio }),
    availableMemoryMb: await availableMemoryMb(),
  };
}

/**
 * The share of all cores busy, from the kernel's own per-core tick counters.
 * Unlike load1 it has no one-minute lag, and unlike a per-process `ps` census
 * it counts the short-lived compilers and test workers a gate spawns: on
 * 2026-10-10 summed `ps` %cpu read 6–10 cores while the kernel had 13–14 busy.
 */
let cpuWindow: { at: number; busy: number; total: number; ratio?: number } | undefined;
function cpuTicks() {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus()) {
    const used = times.user + times.nice + times.sys + times.irq;
    busy += used;
    total += used + times.idle;
  }
  return { at: performance.now(), busy, total };
}
/** Never waits: the first call in a process, or after ten idle seconds, only opens a window. */
function busyCpuRatio(): number | undefined {
  const now = cpuTicks();
  if (!cpuWindow || now.at - cpuWindow.at > 10_000) {
    cpuWindow = now;
    return undefined;
  }
  if (now.at - cpuWindow.at >= 250) {
    const total = now.total - cpuWindow.total;
    if (!(total > 0)) throw new Error("CPU ticks unavailable");
    cpuWindow = { ...now, ratio: Math.min(1, Math.max(0, (now.busy - cpuWindow.busy) / total)) };
  }
  return cpuWindow.ratio;
}
/**
 * Heavy slots sized for the worst case: every job using its full core share
 * and 24 GiB. Up to this many run on the load guard alone (VUH-1981).
 */
export function baseHeavySlots(policy: FleetResourcePolicy): number {
  return Math.min(
    resourceCapacity(policy),
    Math.max(
      1,
      Math.min(
        Math.floor(availableParallelism() / heavyJobParallelism),
        Math.floor(totalmem() / 1024 ** 3 / 24),
      ),
    ),
  );
}
/**
 * The automatic ceiling: two cores and 12 GiB per job. Jobs above the base
 * slots are admitted only while measured pressure stays low (VUH-2054).
 */
export function automaticHeavySlots(): number {
  return Math.max(
    1,
    Math.min(Math.floor(availableParallelism() / 2), Math.floor(totalmem() / 1024 ** 3 / 12)),
  );
}
export function resourceCapacity(policy: FleetResourcePolicy): number {
  return policy.heavySlots ?? automaticHeavySlots();
}
/**
 * A job admitted this recently is charged its full core share: neither load1
 * (a one-minute average) nor a CPU sample has seen it ramp up yet.
 */
export const heavyJobSettleMs = 60_000;
/** Above the base slots, admit while the machine stays under this share of its cores. */
const heavyBurstRatio = 0.7;
/** Memory each unsettled job keeps in reserve above the floor; gates reached about 5 GiB RSS. */
const heavyBurstMemoryMb = 8192;
/**
 * Whether the next queued heavy job may start. `heavySlots` is a ceiling: the
 * base slots run on the load guard, and each one above it needs the measured
 * machine (the busier of load and CPU, plus a full share for every job not yet
 * settled) to stay under `heavyBurstRatio`, with memory to spare.
 */
export function heavyAdmission(
  policy: FleetResourcePolicy,
  pressure: ResourcePressure,
  held: readonly { createdAtMs: number }[],
  at: number,
  settleMs = heavyJobSettleMs,
): "admit" | "slots" | "pressure" {
  if (held.length >= resourceCapacity(policy)) return "slots";
  if (!pressure.healthy) return "pressure";
  if (held.length < baseHeavySlots(policy)) return "admit";
  // No CPU window yet (a fresh waiter, or an injected probe): base slots only.
  if (pressure.cpuRatio === undefined) return "pressure";
  const cores = Math.max(1, availableParallelism());
  const unsettled = held.filter((lease) => at - lease.createdAtMs < settleMs).length;
  const busy = Math.max(pressure.loadRatio, pressure.cpuRatio) * cores + unsettled * heavyJobParallelism;
  if (busy >= heavyBurstRatio * cores) return "pressure";
  if (pressure.availableMemoryMb < policy.minAvailableMemoryMb + (unsettled + 1) * heavyBurstMemoryMb)
    return "pressure";
  return "admit";
}
/**
 * What one booted iOS 27 simulator costs while an app and its UI-test driver
 * run in it: kernel footprint and CPU, measured on the 18-core, 128 GiB Mac
 * (docs/testing/2026-10-09-lean-simulators). An idle one is 27 GiB.
 */
const simulatorCost = { memoryGiB: 34, cores: 2 } as const;
/** A cold boot's CPU burst lasts about two minutes; admit the next simulator after it. */
export const simulatorBootSettleMs = 180_000;
/** Simulators share the machine with heavy slots, so they get at most half of it. */
export function automaticSimulatorSlots(): number {
  return Math.max(
    1,
    Math.min(
      Math.floor(availableParallelism() / 2 / simulatorCost.cores),
      Math.floor(totalmem() / 1024 ** 3 / 2 / simulatorCost.memoryGiB),
    ),
  );
}
export class ResourcePressureSampler {
  private pending: Promise<ResourcePressureInput> | undefined;
  private readonly probe: () => Promise<ResourcePressureInput>;
  constructor(probe: () => Promise<ResourcePressureInput> = defaultProbe) {
    this.probe = probe;
  }
  async sample(policy: FleetResourcePolicy): Promise<ResourcePressure> {
    try {
      this.pending ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            this.probe(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Fleet pressure probe timed out")), 2_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      })().finally(() => {
        this.pending = undefined;
      });
      const input = await this.pending;
      if (
        !Number.isFinite(input.loadRatio) ||
        input.loadRatio < 0 ||
        !Number.isFinite(input.availableMemoryMb) ||
        input.availableMemoryMb < 0 ||
        (input.cpuRatio !== undefined && !(input.cpuRatio >= 0 && input.cpuRatio <= 1))
      )
        throw new Error("Invalid pressure sample");
      const minimum = policy.minAvailableMemoryMb;
      const reason =
        input.loadRatio > policy.maxLoadRatio
          ? "load"
          : input.availableMemoryMb < minimum
            ? "memory"
            : undefined;
      return {
        ...input,
        sampledAtMs: Date.now(),
        healthy: reason === undefined,
        ...(reason ? { reason } : {}),
      };
    } catch {
      return {
        sampledAtMs: Date.now(),
        loadRatio: 0,
        availableMemoryMb: 0,
        healthy: false,
        reason: "probe-unavailable",
      };
    }
  }
}
