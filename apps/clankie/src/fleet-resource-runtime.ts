import {
  createResourceGovernor,
  createSimulatorManager,
  defaultResourcePolicy,
  type FleetResourceGovernor,
  type FleetResourcePolicy,
  type ResourceSnapshot,
  type SimulatorOwner,
} from "@clankie/fleet-resources";
import type { SpawnOperatorSeat } from "@clankie/protocol";
import type { HerdrAgentSnapshot } from "./captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import type { ProjectHireProcessProof } from "./captain/project-hires.ts";
import { fleetQualified, splitFleetQualified } from "./herdr-fleet.ts";

const RESOURCE_BRIEF = [
  "Machine resource safety:",
  "Load the fleet-resources skill. Run every build, test suite, typecheck and other heavy command through `clankie heavy -- <command> [args...]`.",
  "Acquire a named-seat simulator lease through `clankie simulator` before booting a device; use its exact UDID and release it when finished.",
  "Never run global simulator shutdown/delete commands or touch another seat's devices.",
].join("\n");

export class ResourceAdmissionError extends Error {
  public readonly reason: "pressure" | "probe-unavailable";
  public constructor(message: string, reason: "pressure" | "probe-unavailable" = "probe-unavailable") {
    super(message);
    this.name = "ResourceAdmissionError";
    this.reason = reason;
  }
}

interface SeatResolver {
  resolve(seatId: string): Promise<HerdrAgentSnapshot | undefined>;
  proof(fleet: string, pane: string): Promise<ProjectHireProcessProof | undefined>;
  isLocalFleet(fleet?: string): Promise<boolean>;
}

export interface FleetResourceRuntime {
  readonly simulators: ReturnType<typeof createSimulatorManager>;
  bindSeats(resolver: SeatResolver): void;
  /** Cached metadata only. Neither health nor a roster read probes the host. */
  status(): ResourceSnapshot | undefined;
  configure(policy: FleetResourcePolicy): Promise<ResourceSnapshot>;
  refresh(): Promise<void>;
  admitHire(input: Pick<SpawnOperatorSeat, "fleet">): Promise<void>;
  hireBrief(input: Pick<SpawnOperatorSeat, "fleet">, brief?: string): Promise<string | undefined>;
  proveSimulatorSeat(input: { seatId: string; fleet?: string }): Promise<SimulatorOwner>;
  observeSeats(seats: readonly { seatId: string; status: string }[]): Promise<void>;
  observeSeatState(seatId: string, status: string): Promise<void>;
  observeVerifiedSeatExit(owner: SimulatorOwner): Promise<void>;
  onChange(listener: () => void): () => void;
  start(): void;
  close(): Promise<void>;
}

/** One owner-global policy and machine governor, independent of a worker's env or worktree. */
export async function createFleetResourceRuntime(input: {
  policy(): Promise<FleetResourcePolicy | undefined>;
  governor?: FleetResourceGovernor;
  simulator?: Omit<Parameters<typeof createSimulatorManager>[0], "governor" | "observeSeat" | "onChange">;
  refreshMs?: number;
  onError?(error: unknown): void;
}): Promise<FleetResourceRuntime> {
  const governor = input.governor ?? createResourceGovernor();
  const listeners = new Set<() => void>();
  let resolver: SeatResolver | undefined;
  let cached: ResourceSnapshot | undefined;
  let fingerprint: string | undefined;
  let policyFingerprint: string | undefined;
  let refreshing: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const publish = (snapshot: ResourceSnapshot) => {
    cached = snapshot;
    // Keep fresh readings available to doctor without waking the whole idle
    // fleet for a timestamp, a load fluctuation or a lease activity heartbeat.
    const next = JSON.stringify({
      policy: snapshot.policy,
      capacity: snapshot.capacity,
      pressure: { healthy: snapshot.pressure.healthy, reason: snapshot.pressure.reason },
      leases: snapshot.leases.map(({ lastUsedAtMs: _lastUsedAtMs, ...lease }) => lease),
      queue: snapshot.queue,
    });
    if (next === fingerprint) return;
    fingerprint = next;
    for (const listener of listeners) listener();
  };
  const configure = async (policy: FleetResourcePolicy) => {
    const snapshot = await governor.configure(policy);
    policyFingerprint = JSON.stringify(policy);
    publish(snapshot);
    return snapshot;
  };
  const ownerPolicy = async (): Promise<ResourceSnapshot | undefined> => {
    const policy = (await input.policy()) ?? defaultResourcePolicy();
    return JSON.stringify(policy) === policyFingerprint ? undefined : configure(policy);
  };
  const local = async (fleet?: string) => {
    if (!resolver)
      throw new ResourceAdmissionError("Local hire refused: native host authority is not ready.");
    return resolver.isLocalFleet(fleet);
  };
  const observe = async (request: { seatId: string; fleet?: string }) => {
    if (!resolver) throw new Error("Simulator seat proof is not ready.");
    const qualified = splitFleetQualified(request.seatId);
    if (request.fleet && qualified && request.fleet !== qualified.fleet)
      throw new Error("Simulator seat and fleet do not match.");
    const fleet = request.fleet ?? qualified?.fleet;
    if (!(await local(fleet))) throw new Error("Simulator leases require a proven local native seat.");
    const seatId =
      fleet && fleet !== "default" && !qualified ? fleetQualified(fleet, request.seatId) : request.seatId;
    const before = await resolver.resolve(seatId);
    if (!before?.session || before.status === "offline" || before.status === "unknown")
      throw new Error("Simulator seat has no proven live native occupant.");
    const pane = splitFleetQualified(before.paneId);
    if ((pane?.fleet ?? "default") !== (fleet ?? "default")) throw new Error("Simulator seat changed host.");
    const occupantId = occupantIdForHerdrSession(before.session);
    const proof = await resolver.proof(fleet ?? "default", pane?.id ?? before.paneId);
    if (
      !proof ||
      proof.nativeOccupantId !== occupantId ||
      proof.fleet !== (fleet ?? "default") ||
      proof.pane !== (pane?.id ?? before.paneId) ||
      proof.processes.length === 0
    )
      throw new Error("Simulator native process ownership is unavailable.");
    const after = await resolver.resolve(seatId);
    if (
      !after?.session ||
      after.terminalId !== before.terminalId ||
      after.paneId !== before.paneId ||
      occupantIdForHerdrSession(after.session) !== occupantId ||
      after.status === "offline" ||
      after.status === "unknown"
    )
      throw new Error("Simulator native occupant changed during proof.");
    const identity: SimulatorOwner = {
      seatId: after.terminalId,
      occupantId,
      ...(fleet === undefined || fleet === "default" ? {} : { fleet }),
      pane: proof.pane,
      binding: { ...proof.binding },
      processes: proof.processes.map((process) => ({ ...process })),
    };
    return { identity, status: after.status };
  };
  const simulators = createSimulatorManager({
    ...input.simulator,
    governor,
    observeSeat: async (identity) => {
      try {
        const current = await observe(identity);
        return current.identity.occupantId === identity.occupantId ? current : undefined;
      } catch {
        // Failed census/authority is uncertainty, never an exit receipt.
        return undefined;
      }
    },
    onChange: () => void refresh().catch(input.onError ?? (() => {})),
  });
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (refreshing) return refreshing;
    const pending = (async () => publish((await ownerPolicy()) ?? (await governor.snapshot())))();
    refreshing = pending;
    void pending
      .finally(() => {
        if (refreshing === pending) refreshing = undefined;
      })
      .catch(() => {});
    return pending;
  };

  const runtime: FleetResourceRuntime = {
    simulators,
    bindSeats(value) {
      resolver = value;
    },
    status: () => cached,
    configure,
    refresh,
    async admitHire(request) {
      try {
        if (!(await local(request.fleet))) return;
        await ownerPolicy();
        const admission = await governor.admitBuilder();
        if (cached) publish({ ...cached, pressure: admission.pressure });
        if (!admission.allowed) {
          const pressure = admission.pressure;
          throw new ResourceAdmissionError(
            admission.reason === "probe-unavailable"
              ? "Local hire refused: machine pressure could not be verified. Recheck clankie doctor."
              : `Local hire refused: machine pressure is high (${pressure.reason ?? "pressure"}; load/core ${pressure.loadRatio.toFixed(2)}, available memory ${Math.round(pressure.availableMemoryMb)} MiB). Wait for resources or review the owner's fleet resource policy.`,
            admission.reason ?? "probe-unavailable",
          );
        }
      } catch (error) {
        if (error instanceof ResourceAdmissionError) throw error;
        throw new ResourceAdmissionError("Local hire refused: machine resource admission is unavailable.");
      }
    },
    async hireBrief(request, brief) {
      return (await local(request.fleet)) ? [brief, RESOURCE_BRIEF].filter(Boolean).join("\n\n") : brief;
    },
    proveSimulatorSeat: async (request) => (await observe(request)).identity,
    async observeSeats(seats) {
      // Only actual lease holders need process probes; an ordinary roster
      // census never performs one process query per worker.
      const holders = new Set(
        cached?.leases.filter((lease) => lease.kind === "simulator").map((lease) => lease.seatId),
      );
      await Promise.all(
        seats
          .filter((seat) => holders.has(seat.seatId))
          .map((seat) => runtime.observeSeatState(seat.seatId, seat.status)),
      );
    },
    async observeSeatState(seatId, status) {
      if (!cached?.leases.some((lease) => lease.kind === "simulator" && lease.seatId === seatId)) return;
      if (!["idle", "done", "blocked", "working"].includes(status)) return;
      const current = await observe({ seatId });
      if (current.status !== status) return;
      await simulators.observeSeatState(current.identity, status);
    },
    async observeVerifiedSeatExit(owner) {
      await simulators.observeSeatExited(owner);
      await refresh();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (closed || timer) return;
      simulators.start();
      timer = setInterval(() => void refresh().catch(input.onError ?? (() => {})), input.refreshMs ?? 5_000);
      timer.unref();
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      simulators.close();
      await refreshing?.catch(() => {});
      listeners.clear();
      await governor.close();
    },
  };
  // Initialization is metadata-only. Failed probes keep future admission
  // closed, while cached health and the rest of the service remain usable.
  await refresh().catch(input.onError ?? (() => {}));
  return runtime;
}
