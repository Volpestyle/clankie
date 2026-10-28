import {
  automaticSimulatorSlots,
  createResourceGovernor,
  createSimulatorManager,
  longHeldJobMs,
  observeSimulatorReferents,
  unprovenSeatDetail,
  probeProcess,
  type FleetResourceGovernor,
  type ResourceSnapshot,
  type SimulatorDevice,
  type SimulatorHolder,
  type SimulatorOwner,
  type SimulatorReferents,
} from "@clankie/fleet-resources";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import type { FleetResourcePolicy, FleetSeatHook, SpawnOperatorSeat } from "@clankie/protocol";
import type { HerdrAgentSnapshot } from "./captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import type { ProjectHireProcessProof } from "./captain/project-hires.ts";
import { fleetQualified, splitFleetQualified } from "./herdr-fleet.ts";
import type { FleetProgressObservation } from "./fleet-progress.ts";
import { notifyResourceHolderOnce } from "./resource-holder-notices.ts";

/** A simulator request's first proof: three observations about two seconds apart (VUH-2055). */
const PROOF_ATTEMPTS = 3;
const PROOF_RETRY_MS = 2_000;

const RESOURCE_BRIEF = [
  "Machine resource safety:",
  "Load the fleet-resources skill. Run every build, test suite, typecheck and other heavy command through `clankie heavy -- <command> [args...]`.",
  "Dev servers and watch commands use the separate governed server lane automatically; use `clankie heavy --server -- <command> [args...]` for a custom long-lived service, and stop it when finished.",
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
  /** Fresh native state, with a finite validity bound; pane status alone is not activity. */
  activity?(
    agent: HerdrAgentSnapshot,
    holderId?: string,
  ): Promise<{ status: string; activityUntilMs?: number }>;
  isLocalFleet(fleet?: string): Promise<boolean>;
  /** Tell the lead of this pane about it (the fleet alert channel); false when undelivered. */
  notify?(pane: string, text: string): Promise<boolean>;
}
type ObservedSeat = { seatId: string; status: string; paneId?: string };

export interface FleetResourceRuntime {
  /** Internal service-owned scheduling entrypoint for the integration queue. */
  readonly governor: FleetResourceGovernor;
  readonly simulators: ReturnType<typeof createSimulatorManager>;
  bindSeats(resolver: SeatResolver): void;
  /** Cached metadata only. Neither health nor a roster read probes the host. */
  status(): ResourceSnapshot | undefined;
  restartGuard(agent: HerdrAgentSnapshot): Promise<import("@clankie/fleet-resources").RestartResourceGuard>;
  /** Cached real arbiter verdicts; unavailable observations never mean recovery. */
  progress(): readonly FleetProgressObservation[];
  configure(policy: FleetResourcePolicy): Promise<ResourceSnapshot>;
  refresh(): Promise<void>;
  /**
   * Refuses a local hire only on low memory or an unverifiable probe. Returns a
   * receipt notice when the seat's heavy work will queue on current load.
   */
  admitHire(input: Pick<SpawnOperatorSeat, "fleet">): Promise<string | undefined>;
  hireBrief(input: Pick<SpawnOperatorSeat, "fleet">, brief?: string): Promise<string | undefined>;
  /** `retryUnproven` retries a failed observation briefly; a simulator request's first proof uses it. */
  proveSimulatorSeat(
    input: { seatId: string; fleet?: string; holderId?: string },
    options?: { retryUnproven?: boolean },
  ): Promise<SimulatorOwner>;
  /** Original-native renewal; a caller cannot supply lease/process ownership. */
  recordNativeActivity(pane: string, hook: FleetSeatHook, proof: ProjectProcessProof): Promise<boolean>;
  recordRootHook(pane: string, hook: FleetSeatHook, proof: ProjectProcessProof): Promise<boolean>;
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
  /** How often the service admits queued heavy work on its waiters' behalf. */
  arbitrateMs?: number;
  /** How often the refresh loop checks for simulators booted outside leases. */
  externalNoticeMs?: number;
  /** Pause between a simulator request's first-proof attempts. */
  proofRetryMs?: number;
  /** Isolated runtime fixtures may use their own persistent notice directory. */
  holderNoticeDirectory?: string;
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
  let arbiter: ReturnType<typeof setInterval> | undefined;
  let sampler: ReturnType<typeof setInterval> | undefined;
  let arbitrating: Promise<unknown> | undefined;
  let closed = false;
  let progressAt = 0;
  let progress: FleetProgressObservation[] | undefined;
  let priorHeads = new Set<string>();
  /** `${udid}:${seatId}` pairs already told; forgotten once the device is no longer external. */
  const noticed = new Set<string>();
  const holderNoticeDirectory =
    input.holderNoticeDirectory ?? join(userInfo().homedir, ".clankie/fleet-resources/holder-notices");
  let lastNotice = 0;

  const publish = (snapshot: ResourceSnapshot) => {
    cached = snapshot;
    // Keep fresh readings available to doctor without waking the whole idle
    // fleet for a timestamp, a load fluctuation or a lease activity heartbeat.
    const next = JSON.stringify({
      policy: snapshot.policy,
      capacity: snapshot.capacity,
      pressure: {
        healthy: snapshot.pressure.healthy,
        reason: snapshot.pressure.reason,
        diskWarning: snapshot.pressure.diskWarning,
      },
      leases: snapshot.leases.map(({ lastUsedAtMs: _lastUsedAtMs, ...lease }) => lease),
      queue: snapshot.queue,
      lightLeases: snapshot.lightLeases,
      lightQueue: snapshot.lightQueue,
      serverLeases: snapshot.serverLeases,
      serverQueue: snapshot.serverQueue,
      holderAlerts: snapshot.holderAlerts,
    });
    if (next === fingerprint) return;
    fingerprint = next;
    for (const listener of listeners) listener();
  };
  const configure = async (policy: FleetResourcePolicy) => {
    // The shared registry keeps an exact simulator count: every installed
    // reader parses it, so the owner's automatic choice resolves here.
    const snapshot = await governor.configure({
      ...policy,
      simulatorSlots: policy.simulatorSlots ?? automaticSimulatorSlots(),
    });
    policyFingerprint = JSON.stringify(policy);
    publish(snapshot);
    return snapshot;
  };
  const ownerPolicy = async (): Promise<ResourceSnapshot | undefined> => {
    // No owner choice leaves the shared registry as it is. The registry
    // ignores HOME, so a service under a scratch config (a test, an eval)
    // must not reset the machine's live policy to defaults.
    const policy = await input.policy();
    if (!policy) return undefined;
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
      throw owner("The seat could not be looked up in Herdr or its processes observed.");
    }
  };
  /**
   * A request's first proof. Native observation fails in short bursts under
   * load (right after a restart, every seat reconnects at once), so a failed
   * observation is retried briefly before the seat is refused (VUH-2055).
   */
  const proveFirst = async (request: { seatId: string; fleet?: string; holderId?: string }) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await observe(request);
      } catch (error) {
        if (!(error instanceof SimulatorRequestError) || error.reason !== "owner_unavailable") throw error;
        if (attempt >= PROOF_ATTEMPTS) throw owner(unprovenSeatDetail(error.message));
        await delay(input.proofRetryMs ?? PROOF_RETRY_MS);
      }
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
    // allow-swallowed-rejection -- Failed native activity reads confer no renewal; unknown evidence expires.
    const activity = await resolver.activity?.(before, request.holderId).catch(() => undefined);
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
    const renewal = nativeActivity.get(
      JSON.stringify([identity.fleet ?? "default", identity.seatId, identity.holderId]),
    );
    const matched = renewal && renewal.until > Date.now() && isDeepStrictEqual(renewal.owner, identity);
    const activityUntilMs = matched ? renewal.until : activity?.activityUntilMs;
    return {
      identity,
      ...(matched && renewal.state === "idle" ? { idleSinceMs: renewal.stateSince } : {}),
      status: matched ? renewal.state : (activity?.status ?? "unknown"),
      ...(activityUntilMs === undefined ? {} : { activityUntilMs }),
    };
  };
  // Seats seen by the last roster census; attribution maps processes to their panes.
  let seen: readonly ObservedSeat[] = [];
  const nativeProducers = new Map<
    string,
    { owner: SimulatorOwner; instance: number; sequence: number; checkedAt: number }
  >();
  const nativeActivity = new Map<
    string,
    {
      owner: SimulatorOwner;
      instance: number;
      sequence: number;
      checkedAt: number;
      state: "working" | "idle";
      stateSince: number;
      until: number;
    }
  >();
  const noticeHolders = async () => {
    if (!resolver?.notify || closed) return;
    const alerts = cached?.holderAlerts ?? [];
    for (const alert of alerts) {
      if (!alert.seatId || Date.now() - alert.createdAtMs < longHeldJobMs) continue;
      // Caller labels confer no authority: route only through a known native
      // seat/pane from the fleet census, never a caller-chosen conversation.
      const seat = seen.find((seat) => seat.seatId === alert.seatId || seat.paneId === alert.seatId);
      if (!seat?.paneId) continue;
      const age = Math.floor((Date.now() - alert.createdAtMs) / 60_000);
      const text = `Resource holder ${seat.seatId}${alert.holderId ? ` / ${alert.holderId}` : ""}: ${alert.executable} in the ${alert.lane} lane, held ${age} minutes. ${
        alert.reason === "server"
          ? `This long-lived server uses its own slots and shares a ${cached?.capacity.serverCpuCores} CPU-core budget; stop it when finished.`
          : "This bounded job has held its permit over 15 minutes; check whether it is a custom service and use `clankie heavy --server -- COMMAND` on its next launch. It has not been killed for its age."
      }`;
      await notifyResourceHolderOnce(holderNoticeDirectory, alert.id, () =>
        resolver!.notify!(seat.paneId!, text),
      ).catch(input.onError ?? (() => {}));
    }
  };
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
      } catch (error) {
        // Failed census/authority is uncertainty, never an exit receipt.
        return {
          unproven:
            error instanceof SimulatorRequestError ? error.message : "The seat could not be observed.",
        };
      }
    },
    onChange: () => void refresh().catch(input.onError ?? (() => {})),
  });
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (refreshing) return refreshing;
    const pending = (async () => {
      publish((await ownerPolicy()) ?? (await governor.snapshot()));
      await noticeHolders();
    })();
    refreshing = pending;
    void pending
      .finally(() => {
        if (refreshing === pending) refreshing = undefined;
      })
      .catch(() => {});
    return pending;
  };

  const runtime: FleetResourceRuntime = {
    governor,
    simulators,
    bindSeats(value) {
      resolver = value;
    },
    status: () => cached,
    async restartGuard(agent) {
      try {
        const qualified = splitFleetQualified(agent.paneId);
        if (!(await local(qualified?.fleet)))
          return { clear: false, reason: "restart_resource_host_unavailable" };
        const observed = await observe({
          seatId: agent.terminalId,
          ...(qualified ? { fleet: qualified.fleet } : {}),
        });
        if (
          !agent.session ||
          observed.identity.occupantId !== occupantIdForHerdrSession(agent.session) ||
          observed.identity.pane !== (qualified?.id ?? agent.paneId) ||
          observed.status !== "idle"
        )
          return { clear: false, reason: "restart_resource_native_changed" };
        if (!governor.restartGuard) return { clear: false, reason: "restart_resource_guard_unavailable" };
        return await governor.restartGuard(observed.identity);
      } catch (error) {
        return { clear: false, reason: "restart_resource_proof_unknown", detail: String(error) };
      }
    },
    progress() {
      if (!progress || Date.now() - progressAt > 5_000)
        throw Error("Heavy arbiter admission observation unavailable");
      return progress;
    },
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
    proveSimulatorSeat: async (request, options) =>
      (await (options?.retryUnproven ? proveFirst(request) : observe(request))).identity,
    async recordRootHook(pane, hook, proof) {
      if (
        closed ||
        proof.nativeSessionPending ||
        hook.agentId !== undefined ||
        hook.occurredAt === undefined ||
        !["UserPromptSubmit", "PreToolUse", "PostToolUse"].includes(hook.event)
      )
        return false;
      // Almost every tool call has no simulator. Do not re-prove native ownership then.
      const held = await governor.simulatorReservations();
      if (
        !held.some(
          (lease) =>
            lease.holderId === `claude:${hook.sessionId}` &&
            lease.pane === proof.pane &&
            lease.occupantId === proof.nativeOccupantId &&
            (lease.fleet ?? "default") === proof.fleet,
        )
      )
        return false;
      const agent = await resolver?.resolve(pane);
      const session = agent?.session;
      if (
        agent?.agent !== "claude" ||
        !session ||
        (session.kind === "id" ? session.value : basename(session.value, ".jsonl")) !== hook.sessionId
      )
        return false;
      const owner = await runtime
        .proveSimulatorSeat({ seatId: pane, holderId: `claude:${hook.sessionId}` })
        // allow-swallowed-rejection -- Lost native ownership cannot grant event time.
        .catch(() => undefined);
      if (!owner) return false;
      if (
        owner.occupantId !== proof.nativeOccupantId ||
        (owner.fleet ?? "default") !== proof.fleet ||
        owner.pane !== proof.pane ||
        !isDeepStrictEqual(owner.binding, proof.binding) ||
        !isDeepStrictEqual(owner.processes, proof.processes)
      )
        return false;
      return simulators.recordActivity(owner, Date.parse(hook.occurredAt));
    },
    async recordNativeActivity(pane, hook, proof) {
      const report = hook.activity;
      if (closed || hook.event !== "NativeActivity" || !report || proof.nativeSessionPending) return false;
      const checkedAt = Date.parse(report.checkedAt),
        instance = Date.parse(report.instanceStartedAt),
        at = Date.now();
      // Receipt time alone would make a replay or delayed request immortal.
      // Both native clock and receipt bound the fact to fifteen seconds.
      if (
        !Number.isFinite(checkedAt) ||
        !Number.isFinite(instance) ||
        instance > checkedAt ||
        checkedAt > at ||
        checkedAt <= at - 15_000 ||
        new Set(report.children.map((child) => child.agentId)).size !== report.children.length ||
        report.children.some(
          (child) =>
            !Number.isFinite(Date.parse(child.stateSince)) ||
            Date.parse(child.stateSince) < instance ||
            Date.parse(child.stateSince) > checkedAt,
        )
      )
        return false;
      // allow-swallowed-rejection -- Failed seat resolution rejects this activity admission below.
      const agent = await resolver?.resolve(pane).catch(() => undefined);
      const session = agent?.session;
      if (
        agent?.agent !== "claude" ||
        !session ||
        (session.kind === "id" ? session.value : basename(session.value, ".jsonl")) !== hook.sessionId
      )
        return false;
      const owner = await runtime
        .proveSimulatorSeat({ seatId: pane, holderId: `claude:${hook.sessionId}` })
        // allow-swallowed-rejection -- Unavailable ownership proof rejects this activity admission below.
        .catch(() => undefined);
      if (
        !owner ||
        owner.occupantId !== proof.nativeOccupantId ||
        (owner.fleet ?? "default") !== proof.fleet ||
        owner.pane !== proof.pane ||
        !isDeepStrictEqual(owner.binding, proof.binding) ||
        !isDeepStrictEqual(owner.processes, proof.processes) ||
        !proof.processes.some((process) => process.pid === report.producerPid)
      )
        return false;
      if (!(await Promise.all(owner.processes.map(probeProcess))).every((state) => state === "live"))
        return false;
      const key = JSON.stringify([owner.fleet ?? "default", owner.seatId, owner.holderId]);
      const previous = nativeProducers.get(key);
      if (
        previous &&
        isDeepStrictEqual(previous.owner, owner) &&
        (instance < previous.instance ||
          (instance === previous.instance && report.sequence <= previous.sequence) ||
          checkedAt < previous.checkedAt)
      )
        return false;
      if (Date.now() - checkedAt >= 15_000) return false;
      // This root entry is only the producer's sequence fence. The native
      // API does not identify root turns, so it never renews a root lease.
      nativeProducers.set(key, { owner, instance, sequence: report.sequence, checkedAt });
      while (nativeProducers.size > 128) nativeProducers.delete(nativeProducers.keys().next().value!);
      const holders = new Set(
        report.children.map((child) => `claude:${hook.sessionId}:agent:${child.agentId}`),
      );
      for (const [id, entry] of nativeActivity) {
        if (
          id !== key &&
          entry.owner.seatId === owner.seatId &&
          entry.owner.occupantId === owner.occupantId &&
          entry.owner.holderId?.startsWith(`claude:${hook.sessionId}:agent:`) &&
          !holders.has(entry.owner.holderId)
        )
          nativeActivity.delete(id);
      }
      for (const child of report.children) {
        const childOwner = { ...owner, holderId: `claude:${hook.sessionId}:agent:${child.agentId}` };
        nativeActivity.set(JSON.stringify([owner.fleet ?? "default", owner.seatId, childOwner.holderId]), {
          owner: childOwner,
          instance,
          sequence: report.sequence,
          checkedAt,
          state: child.state,
          stateSince: Date.parse(child.stateSince),
          until: Math.min(checkedAt + 15_000, at + 15_000),
        });
      }
      while (nativeActivity.size > 128) nativeActivity.delete(nativeActivity.keys().next().value!);
      await simulators.tick();
      return true;
    },
    async observeSeats(seats) {
      seen = seats.map(({ seatId, status, paneId }) => ({ seatId, status, ...(paneId ? { paneId } : {}) }));
      await noticeHolders();
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
      // The service judges heavy admission once for every waiter, so one
      // waiter's wrong view of the machine cannot hold the FIFO (VUH-2080).
      arbiter = setInterval(() => {
        if (arbitrating) return;
        arbitrating = governor
          .arbitrate()
          .then(() => {
            const verdict = governor.arbitration();
            if (!verdict) {
              progress = undefined;
              priorHeads.clear();
              return;
            }
            progressAt = verdict.atMs;
            progress = verdict.heads.map((head) => {
              const id = `heavy:${head.lane}:${head.ticketId}`;
              return {
                id,
                stalled: head.admits && priorHeads.has(id) && verdict.atMs - head.queuedAtMs > 60_000,
                // A marked admitted head is granted in the same transaction. The
                // remaining eligible head has no marker (older client or wedge).
                message: `Heavy ${head.lane} lane head stalled: ticket ${head.ticketId}, owner seat ${head.seatId ?? "unknown"}, holder ${head.holderId ?? "unknown"}, PID ${head.pid}, queued since ${new Date(head.queuedAtMs).toISOString()}. Consecutive sampled verdicts permit admission, but the grant marker is absent (older client or missing marker). Inspect clankie fleet resources; no automatic repair.`,
              };
            });
            priorHeads = new Set(
              verdict.heads
                .filter((head) => head.admits)
                .map((head) => `heavy:${head.lane}:${head.ticketId}`),
            );
          })
          .catch((error) => {
            progress = undefined;
            priorHeads.clear();
            input.onError?.(error);
          })
          .finally(() => {
            arbitrating = undefined;
          });
      }, input.arbitrateMs ?? 1_000);
      arbiter.unref();
      // History for explaining load afterwards: admission keeps none (VUH-2933).
      sampler = setInterval(() => {
        void governor.recordMachineSample?.().catch(input.onError ?? (() => {}));
      }, 30_000);
      sampler.unref();
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (arbiter) clearInterval(arbiter);
      arbiter = undefined;
      if (sampler) clearInterval(sampler);
      sampler = undefined;
      await arbitrating;
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
