import { availableParallelism, totalmem } from "node:os";
import type { FleetResourcePolicy } from "./model.ts";
import { heavyJobParallelism } from "./parallelism.ts";

/** Measured by the resource runtime's host, never supplied by a heavy-command client. */
export interface ResourceHostSpecs {
  cores: number;
  memoryBytes: number;
}
function localSpecs(): ResourceHostSpecs {
  return { cores: availableParallelism(), memoryBytes: totalmem() };
}
function validateHostSpecs(host: ResourceHostSpecs): void {
  if (
    !Number.isSafeInteger(host.cores) ||
    host.cores < 1 ||
    host.cores > 4096 ||
    !Number.isSafeInteger(host.memoryBytes) ||
    host.memoryBytes < 1
  )
    throw new Error("Invalid resource host specs");
}
/** Every job using its full core share and 24 GiB (VUH-1981). */
function worstCaseSlots(host: ResourceHostSpecs): number {
  validateHostSpecs(host);
  return Math.max(
    1,
    Math.min(Math.floor(host.cores / heavyJobParallelism), Math.floor(host.memoryBytes / 1024 ** 3 / 24)),
  );
}
/**
 * The heavy lane's slots: the owner's `heavySlots`, else the worst-case
 * sizing, since no machine reading gates admission (#599).
 */
export function resourceCapacity(policy: FleetResourcePolicy, host = localSpecs()): number {
  return policy.heavySlots ?? worstCaseSlots(host);
}
/** The light lane's slots: the heavy slots, at most the worst-case sizing. */
export function baseHeavySlots(policy: FleetResourcePolicy, host = localSpecs()): number {
  return Math.min(resourceCapacity(policy, host), worstCaseSlots(host));
}
/**
 * What one booted iOS 27 simulator costs while an app and its UI-test driver
 * run in it: kernel footprint and CPU, measured on the 18-core, 128 GiB Mac
 * (clankie-ops archive/clankie-docs-testing/2026-10-09-lean-simulators). An idle one is 27 GiB.
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
