import {
  createResourceGovernor,
  createSimulatorManager,
  defaultResourcePolicy,
  observeSimulatorReferents,
  type FleetResourceGovernor,
  type FleetResourcePolicy,
  type ResourceSnapshot,
  type SimulatorDevice,
  type SimulatorHolder,
  type SimulatorOwner,
  type SimulatorReferents,
} from "@clankie/fleet-resources";
import type { SpawnOperatorSeat } from "@clankie/protocol";
import type { HerdrAgentSnapshot } from "./captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import type { ProjectHireProcessProof } from "./captain/project-hires.ts";
import { fleetQualified, splitFleetQualified } from "./herdr-fleet.ts";

const RESOURCE_BRIEF = [
  "Machine resource safety:",
  "Load the fleet-resources skill. Run every build, test suite, typecheck and other heavy command through `clankie heavy -- <command> [args...]`.",
  "Boot simulators only through `clankie simulator acquire` (never `xcrun simctl boot` or Simulator.app); use its exact UDID and release it when finished. A device you booted by hand holds a fleet slot: lease it by its deviceId or shut it down.",
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

/** A simulator request the runtime refuses, with the cause the caller should see. */
export class SimulatorRequestError extends Error {
  public readonly reason: "owner_unavailable" | "service_restarting" | "seat_not_local";
  public constructor(reason: SimulatorRequestError["reason"], message: string) {
    super(message);
    this.name = "SimulatorRequestError";
    this.reason = reason;
  }
}

interface SeatResolver {
  resolve(seatId: string): Promise<HerdrAgentSnapshot | undefined>;
  proof(fleet: string, pane: string): Promise<ProjectHireProcessProof | undefined>;
  isLocalFleet(fleet?: string): Promise<boolean>;
  /** Tell the lead of this pane about it (the fleet alert channel); false when undelivered. */
  notify?(pane: string, text: string): Promise<boolean>;
}
type ObservedSeat = { seatId: string; status: string; paneId?: string };

export interface FleetResourceRuntime {
  readonly simulators: ReturnType<typeof createSimulatorManager>;
  bindSeats(resolver: SeatResolver): void;
  /** Cached metadata only. Neither health nor a roster read probes the host. */
  status(): ResourceSnapshot | undefined;
  configure(policy: FleetResourcePolicy): Promise<ResourceSnapshot>;
  refresh(): Promise<void>;
  /**
   * Refuses a local hire only on low memory or an unverifiable probe. Returns a
   * receipt notice when the seat's heavy work will queue on current load.
   */
  admitHire(input: Pick<SpawnOperatorSeat, "fleet">): Promise<string | undefined>;
  hireBrief(input: Pick<SpawnOperatorSeat, "fleet">, brief?: string): Promise<string | undefined>;
  proveSimulatorSeat(input: { seatId: string; fleet?: string; holderId?: string }): Promise<SimulatorOwner>;
  observeSeats(seats: readonly ObservedSeat[]): Promise<void>;
  /** Notice seats whose panes use simulators booted outside leases. */
  noticeExternalSimulators(): Promise<void>;
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
  /** Injectable for tests; the shipped helper scans this user's processes. */
  referents?: (needles: readonly string[]) => Promise<SimulatorReferents>;
  refreshMs?: number;
  /** How often the refresh loop checks for simulators booted outside leases. */
  externalNoticeMs?: number;
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
  /** `${udid}:${seatId}` pairs already told; forgotten once the device is no longer external. */
  const noticed = new Set<string>();
  let lastNotice = 0;

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
  const owner = (message: string) => new SimulatorRequestError("owner_unavailable", message);
  const observe = async (request: { seatId: string; fleet?: string; holderId?: string }) => {
    try {
      return await observeSeat(request);
    } catch (error) {
      if (error instanceof SimulatorRequestError) throw error;
      // Herdr or the process observer failed: the owner check could not run.
      throw owner("The seat could not be looked up in Herdr or its processes observed; retry.");
    }
  };
  const observeSeat = async (request: { seatId: string; fleet?: string; holderId?: string }) => {
    // Startup binds the seat resolver after the routes exist; shutdown closes it.
    if (!resolver || closed)
      throw new SimulatorRequestError(
        "service_restarting",
        "Clankie is starting or stopping; retry shortly.",
      );
    const qualified = splitFleetQualified(request.seatId);
    if (request.fleet && qualified && request.fleet !== qualified.fleet)
      throw owner("Simulator seat and fleet do not match.");
    const fleet = request.fleet ?? qualified?.fleet;
    if (!(await local(fleet)))
      throw new SimulatorRequestError("seat_not_local", "Simulator leases require a local native seat.");
    const seatId =
      fleet && fleet !== "default" && !qualified ? fleetQualified(fleet, request.seatId) : request.seatId;
    const before = await resolver.resolve(seatId);
    if (!before?.session || before.status === "offline" || before.status === "unknown")
      throw owner("Simulator seat has no proven live native occupant.");
    const pane = splitFleetQualified(before.paneId);
    if ((pane?.fleet ?? "default") !== (fleet ?? "default")) throw owner("Simulator seat changed host.");
    const occupantId = occupantIdForHerdrSession(before.session);
    const proof = await resolver.proof(fleet ?? "default", pane?.id ?? before.paneId);
    if (
      !proof ||
      proof.nativeOccupantId !== occupantId ||
      proof.fleet !== (fleet ?? "default") ||
      proof.pane !== (pane?.id ?? before.paneId) ||
      proof.processes.length === 0
    )
      throw owner("Simulator native process ownership is unavailable.");
    const after = await resolver.resolve(seatId);
    if (
      !after?.session ||
      after.terminalId !== before.terminalId ||
      after.paneId !== before.paneId ||
      occupantIdForHerdrSession(after.session) !== occupantId ||
      after.status === "offline" ||
      after.status === "unknown"
    )
      throw owner("Simulator native occupant changed during proof.");
    const identity: SimulatorOwner = {
      seatId: after.terminalId,
      occupantId,
      ...(request.holderId === undefined ? {} : { holderId: request.holderId }),
      ...(fleet === undefined || fleet === "default" ? {} : { fleet }),
      pane: proof.pane,
      binding: { ...proof.binding },
      processes: proof.processes.map((process) => ({ ...process })),
    };
    return { identity, status: after.status };
  };
  // Seats seen by the last roster census; attribution maps processes to their panes.
  let seen: readonly ObservedSeat[] = [];
  let seatProcesses: { at: number; byPid: Map<number, { seatId: string; pane: string }> } | undefined;
  const panesByPid = async () => {
    if (seatProcesses && Date.now() - seatProcesses.at < 15_000) return seatProcesses.byPid;
    const byPid = new Map<number, { seatId: string; pane: string }>();
    await Promise.all(
      seen.map(async (seat) => {
        if (!resolver || !seat.paneId) return;
        const pane = splitFleetQualified(seat.paneId);
        const fleet = pane?.fleet ?? "default";
        if (!(await resolver.isLocalFleet(fleet).catch(() => false))) return;
        const proof = await resolver.proof(fleet, pane?.id ?? seat.paneId).catch(() => undefined);
        if (!proof) return;
        for (const process of [proof.shell, ...proof.processes])
          byPid.set(process.pid, { seatId: seat.seatId, pane: seat.paneId });
      }),
    );
    seatProcesses = { at: Date.now(), byPid };
    return byPid;
  };
  const referents = input.referents ?? observeSimulatorReferents;
  /** CoreSimulator's own per-device processes name the device but say nothing about who uses it. */
  const internal = new Set([
    "launchd_sim",
    "CoreSimulatorService",
    "simctl",
    "com.apple.CoreSimulator.CoreSimulatorService",
  ]);
  const attribute = async (devices: readonly SimulatorDevice[], inventory: readonly SimulatorDevice[]) => {
    // A name identifies a device only when no other device shares it.
    const unique = (device: SimulatorDevice) =>
      inventory.filter((row) => row.name === device.name).length === 1 ? [device.name] : [];
    const needlesFor = (device: SimulatorDevice) => [device.udid, ...unique(device)];
    const found = await referents(devices.flatMap(needlesFor));
    const panes = await panesByPid();
    const result = new Map<string, SimulatorHolder[]>();
    for (const device of devices) {
      const holders = new Map<number, SimulatorHolder>();
      for (const needle of needlesFor(device)) {
        for (const pid of found.matches.get(needle) ?? []) {
          let seat: { seatId: string; pane: string } | undefined;
          let skip = false;
          for (let current = pid, depth = 0; current > 1 && depth < 64; depth++) {
            const row = found.processes.get(current);
            if (!row) break;
            if (internal.has(row.executable)) skip = true;
            seat ??= panes.get(current);
            current = row.ppid;
          }
          const row = found.processes.get(pid);
          if (skip || !row || holders.has(pid)) continue;
          holders.set(pid, {
            pid,
            executable: row.executable,
            ...(seat ? { seatId: seat.seatId, pane: seat.pane } : {}),
          });
        }
      }
      if (holders.size) result.set(device.udid, [...holders.values()]);
    }
    return result;
  };
  const simulators = createSimulatorManager({
    attribute,
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
        if (!(await local(request.fleet))) return undefined;
        await ownerPolicy();
        const admission = await governor.admitBuilder();
        const pressure = admission.pressure;
        if (cached) publish({ ...cached, pressure });
        if (!admission.allowed)
          throw new ResourceAdmissionError(
            admission.reason === "probe-unavailable"
              ? "Local hire refused: machine pressure could not be verified. Recheck clankie doctor."
              : `Local hire refused: available memory ${Math.round(pressure.availableMemoryMb)} MiB is below the ${String(admission.minAvailableMemoryMb)} MiB floor. Wait for memory to free up or review the owner's fleet resource policy.`,
            admission.reason ?? "probe-unavailable",
          );
        return admission.heavyQueued
          ? `Machine load is high (load/core ${pressure.loadRatio.toFixed(2)}, heavy limit ${admission.heavyQueued.maxLoadRatio.toFixed(2)}): this seat's \`clankie heavy\` builds, tests and simulator leases will queue until load drops.`
          : undefined;
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
      seen = seats.map(({ seatId, status, paneId }) => ({ seatId, status, ...(paneId ? { paneId } : {}) }));
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
    async noticeExternalSimulators() {
      if (closed || !resolver?.notify || process.platform !== "darwin") return;
      const { external: devices, inventory } = await simulators.externalDevices();
      const current = new Set(devices.map((device) => device.udid));
      for (const key of noticed) if (!current.has(key.split(":")[0]!)) noticed.delete(key);
      if (!devices.length) return;
      const holders = await attribute(devices, inventory);
      const slots = (await governor.snapshot()).policy.simulatorSlots;
      for (const device of devices) {
        const seats = new Map(
          (holders.get(device.udid) ?? []).flatMap((holder) =>
            holder.seatId && holder.pane ? [[holder.seatId, holder.pane] as const] : [],
          ),
        );
        for (const [seatId, pane] of seats) {
          const key = `${device.udid}:${seatId}`;
          if (noticed.has(key)) continue;
          const text = `Seat ${seatId} is using simulator "${device.name}" (${device.udid}), which was booted outside a fleet lease. It holds one of ${slots} fleet simulator slot(s), so other lanes' \`clankie simulator acquire\` waits on it. Have the seat lease it with \`clankie simulator acquire '{"seatId":"${seatId}","deviceId":"${device.udid}"}'\` (its release shuts the device down) or shut it down with \`xcrun simctl shutdown ${device.udid}\` when done, and boot simulators only through \`clankie simulator acquire\`.`;
          if (await resolver.notify(pane, text).catch(() => false)) noticed.add(key);
        }
      }
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
      timer = setInterval(() => {
        void refresh().catch(input.onError ?? (() => {}));
        if (Date.now() - lastNotice < (input.externalNoticeMs ?? 30_000)) return;
        lastNotice = Date.now();
        // CoreSimulator may be briefly unreadable; the next round retries quietly.
        void runtime.noticeExternalSimulators().catch(() => {});
      }, input.refreshMs ?? 5_000);
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
