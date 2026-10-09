import { readFile } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
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
  return {
    loadRatio: loadavg()[0]! / Math.max(1, availableParallelism()),
    availableMemoryMb: await availableMemoryMb(),
  };
}

export function automaticHeavySlots(): number {
  return Math.max(
    1,
    Math.min(
      Math.floor(availableParallelism() / heavyJobParallelism),
      Math.floor(totalmem() / 1024 ** 3 / 24),
    ),
  );
}
export function resourceCapacity(policy: FleetResourcePolicy): number {
  return policy.heavySlots ?? automaticHeavySlots();
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
        input.availableMemoryMb < 0
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
