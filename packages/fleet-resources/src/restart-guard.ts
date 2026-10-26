import type { ProcessIdentity, ProcessProof, ResourceState } from "./model.ts";
import type { SimulatorOwner } from "./simulators.ts";
import { observeProcesses, processAncestry } from "./process.ts";

export type RestartResourceGuard = { clear: true } | { clear: false; reason: string; detail?: string };

function entryProofs(
  entry: ResourceState["leases"][number] | ResourceState["queue"][number],
): ProcessProof[] {
  if ("kind" in entry && entry.kind === "simulator" && "ownerProcesses" in entry)
    return entry.ownerProcesses ?? [];
  return "claimOwner" in entry
    ? [entry.claimOwner, ...(entry.runner ? [entry.runner] : []), ...(entry.descendants ?? [])]
    : "owner" in entry
      ? [entry.owner]
      : [];
}

/** A negative proof needs private births and fresh ancestry, never the public status projection. */
export async function proveRestartResources(
  owner: SimulatorOwner,
  read: () => Promise<readonly ResourceState[]>,
  observe?: () => Promise<ProcessIdentity[]>,
  observeAncestry: typeof processAncestry = processAncestry,
): Promise<RestartResourceGuard> {
  try {
    if (!owner.processes.length || !owner.binding?.socketPath)
      return { clear: false, reason: "resource_provenance_unknown" };
    const before = await read();
    if (before.length !== 3) return { clear: false, reason: "resource_inventory_incomplete" };
    // A transient unrelated process must not invalidate exact journal births.
    // Omitted or uncertain requested PIDs remain unknown, never proved exited.
    const relevantPids = [
      ...owner.processes.map(({ pid }) => pid),
      ...before.flatMap((state) =>
        [...state.leases, ...state.queue].flatMap(entryProofs).map(({ pid }) => pid),
      ),
    ];
    const readBirths =
      observe ??
      (async () =>
        [...(await observeProcesses(relevantPids)).values()].flatMap((row) =>
          row.status === "live" ? [row.identity] : [],
        ));
    const processes = await readBirths();
    const byPid = new Map(processes.map((process) => [process.pid, process]));
    const matches = (actual: ProcessIdentity | undefined, proof: ProcessProof) =>
      actual !== undefined &&
      actual.pid === proof.pid &&
      (actual.startTime === proof.startTime || actual.legacyStartTime === proof.startTime);
    if (owner.processes.some((proof) => !matches(byPid.get(proof.pid), proof)))
      return { clear: false, reason: "resource_owner_birth_unknown" };
    const roots = new Set(owner.processes.map((proof) => proof.pid));
    // Births remain exact, private authority. These all-user parent links
    // only classify ancestry; they never establish a holder's birth or liveness.
    const ancestry = new Map((await observeAncestry()).map((row) => [row.pid, row]));
    if (
      owner.processes.some(
        ({ pid }) =>
          ancestry.get(pid)?.uid !== byPid.get(pid)?.uid || ancestry.get(pid)?.ppid !== byPid.get(pid)?.ppid,
      )
    )
      return { clear: false, reason: "resource_owner_birth_unknown" };
    const ownerAncestors = owner.processes.map(({ pid }) => {
      const ancestors = new Set<number>();
      let current = ancestry.get(pid);
      while (current && current.ppid > 1 && !ancestors.has(current.ppid)) {
        ancestors.add(current.ppid);
        current = ancestry.get(current.ppid);
      }
      return ancestors;
    });
    // Reaching a strict ancestor of every owned root proves a different branch,
    // even when a login process above that shared ancestor is unobservable.
    const unrelatedBoundaries = new Set(
      [...ownerAncestors[0]!].filter(
        (pid) => !roots.has(pid) && ownerAncestors.every((ancestors) => ancestors.has(pid)),
      ),
    );
    const belongs = (proof: ProcessProof): boolean | undefined => {
      const identity = byPid.get(proof.pid);
      if (!matches(identity, proof)) return undefined;
      let current = ancestry.get(proof.pid);
      if (!current || current.uid !== identity!.uid || current.ppid !== identity!.ppid) return undefined;
      const seen = new Set<number>();
      while (current) {
        if (roots.has(current.pid)) return true;
        if (seen.has(current.pid)) return undefined;
        seen.add(current.pid);
        if (unrelatedBoundaries.has(current.pid)) return false;
        // Reparenting erases ancestry. PID 1 cannot prove that a live holder
        // never belonged to this seat; only a known unrelated branch can.
        if (current.ppid <= 1) return undefined;
        current = ancestry.get(current.ppid);
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
        const proofs = entryProofs(entry);
        if (!proofs.length) return { clear: false, reason: "resource_attribution_unknown", detail: entry.id };
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
    // Bracket the topology census with exact births: a reused PID or changed
    // parent must not make unrelated topology stand in for a journaled holder.
    const afterBirths = new Map((await readBirths()).map((process) => [process.pid, process]));
    const stable = (proof: ProcessProof) => {
      const prior = byPid.get(proof.pid),
        current = afterBirths.get(proof.pid);
      return (
        matches(current, proof) &&
        prior !== undefined &&
        current !== undefined &&
        prior.startTime === current.startTime &&
        prior.uid === current.uid &&
        prior.ppid === current.ppid
      );
    };
    if (owner.processes.some((proof) => !stable(proof)))
      return { clear: false, reason: "resource_owner_birth_unknown" };
    for (const state of before)
      for (const entry of [...state.leases, ...state.queue])
        if (entryProofs(entry).some((proof) => !stable(proof)))
          return { clear: false, reason: "resource_attribution_unknown", detail: entry.id };
    // Register/cancel/settle during the native census invalidates this negative proof.
    if (JSON.stringify(before) !== JSON.stringify(await read()))
      return { clear: false, reason: "resource_inventory_changed" };
    return { clear: true };
  } catch (error) {
    return { clear: false, reason: "resource_inventory_unknown", detail: String(error) };
  }
}
