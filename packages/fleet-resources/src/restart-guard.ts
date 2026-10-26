import type { ProcessIdentity, ProcessProof, ResourceState } from "./model.ts";
import type { SimulatorOwner } from "./simulators.ts";
import { processSnapshot } from "./process.ts";

export type RestartResourceGuard = { clear: true } | { clear: false; reason: string; detail?: string };

/** A negative proof needs private births and fresh ancestry, never the public status projection. */
export async function proveRestartResources(
  owner: SimulatorOwner,
  read: () => Promise<readonly ResourceState[]>,
  observe: () => Promise<ProcessIdentity[]> = () => processSnapshot(true),
): Promise<RestartResourceGuard> {
  try {
    if (!owner.processes.length || !owner.binding?.socketPath)
      return { clear: false, reason: "resource_provenance_unknown" };
    const before = await read();
    if (before.length !== 3) return { clear: false, reason: "resource_inventory_incomplete" };
    const processes = await observe();
    const byPid = new Map(processes.map((process) => [process.pid, process]));
    const matches = (actual: ProcessIdentity | undefined, proof: ProcessProof) =>
      actual !== undefined &&
      actual.pid === proof.pid &&
      (actual.startTime === proof.startTime || actual.legacyStartTime === proof.startTime);
    if (owner.processes.some((proof) => !matches(byPid.get(proof.pid), proof)))
      return { clear: false, reason: "resource_owner_birth_unknown" };
    const roots = new Set(owner.processes.map((proof) => proof.pid));
    const belongs = (proof: ProcessProof): boolean | undefined => {
      let current = byPid.get(proof.pid);
      if (!matches(current, proof)) return undefined;
      const seen = new Set<number>();
      while (current) {
        if (roots.has(current.pid)) return true;
        if (seen.has(current.pid)) return undefined;
        seen.add(current.pid);
        if (current.ppid <= 1) return false;
        current = byPid.get(current.ppid);
      }
      return undefined;
    };
    for (const state of before) {
      for (const entry of [...state.leases, ...state.queue]) {
        if (
          entry.seatId === owner.seatId ||
          entry.seatId === owner.pane ||
          ("occupantId" in entry && entry.occupantId === owner.occupantId) ||
          ("simulator" in entry && entry.simulator?.occupantId === owner.occupantId)
        )
          return { clear: false, reason: "resource_held_or_queued", detail: entry.id };
        if ("kind" in entry && entry.kind === "simulator" && "ownerProcesses" in entry) {
          const proof = entry.ownerProcesses;
          if (!proof?.length)
            return { clear: false, reason: "resource_attribution_unknown", detail: entry.id };
          for (const process of proof) {
            const related = belongs(process);
            if (related !== false)
              return {
                clear: false,
                reason: related ? "resource_held_or_queued" : "resource_attribution_unknown",
                detail: entry.id,
              };
          }
        } else {
          const proofs =
            "claimOwner" in entry
              ? [entry.claimOwner, ...(entry.runner ? [entry.runner] : []), ...(entry.descendants ?? [])]
              : "owner" in entry
                ? [entry.owner]
                : [];
          if (!proofs.length)
            return { clear: false, reason: "resource_attribution_unknown", detail: entry.id };
          for (const process of proofs) {
            const related = belongs(process);
            if (related !== false)
              return {
                clear: false,
                reason: related ? "resource_held_or_queued" : "resource_attribution_unknown",
                detail: entry.id,
              };
          }
        }
      }
    }
    // Register/cancel/settle during the native census invalidates this negative proof.
    if (JSON.stringify(before) !== JSON.stringify(await read()))
      return { clear: false, reason: "resource_inventory_changed" };
    return { clear: true };
  } catch (error) {
    return { clear: false, reason: "resource_inventory_unknown", detail: String(error) };
  }
}
