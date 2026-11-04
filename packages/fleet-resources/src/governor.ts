import { observeSimulatorUsage, simulatorUsageFor } from "./simulator-usage.ts";
import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { availableParallelism, constants, freemem, loadavg, userInfo } from "node:os";
import { basename, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  FleetResourcePolicySchema,
  type FleetResourceGovernor,
  type FleetResourcePolicy,
  type HeavyLease,
  type HeavyRunOptions,
  type ProcessIdentity,
  type ResourceSnapshot,
  type ResourceState,
  type ResourceWaitOptions,
  type SimulatorReservation,
  type SimulatorSettledReceipt,
  type SimulatorUpdate,
  type ResourceQueueEntry,
} from "./model.ts";
import {
  processGroupOccupied,
  processIdentity,
  probeProcess,
  observeProcesses,
  resourceNativeHelperPath,
  resourcePython,
} from "./process.ts";
import { baseHeavySlots, resourceCapacity, simulatorBootSettleMs } from "./sizing.ts";
import { ResourceStore } from "./store.ts";
import { appendRecords, leaseCommand, recordLease } from "./records.ts";
import { proveRestartResources } from "./restart-guard.ts";
import {
  heavyJobArgs,
  heavyJobEnvironment,
  heavyJobLane,
  heavyJobParallelism,
  lightJobParallelism,
  serverJobParallelism,
  serverLaneCapacity,
  longHeldJobMs,
  type HeavyJobLane,
} from "./parallelism.ts";

const sameQueue = (
  a: NonNullable<ResourceQueueEntry["simulator"]>,
  b: NonNullable<ResourceQueueEntry["simulator"]>,
) =>
  a.targetDeviceId && b.targetDeviceId
    ? a.targetDeviceId === b.targetDeviceId
    : a.runtime === b.runtime && a.deviceType === b.deviceType;
const ticketOwner = (
  entry: ResourceQueueEntry,
  owner: { seatId: string; holderId?: string; occupantId: string; fleet?: string },
) =>
  entry.kind === "simulator" &&
  entry.seatId === owner.seatId &&
  entry.holderId === owner.holderId &&
  entry.simulator?.occupantId === owner.occupantId &&
  (entry.simulator?.fleet ?? "default") === (owner.fleet ?? "default");
const abort = () => new DOMException("Fleet resource wait cancelled", "AbortError");
type SimulatorBlock = "simulator_capacity" | "shared_capacity" | "pressure";
/** The owner's simulator limit is zero; distinct from an unavailable registry. */
export class SimulatorsDisabledError extends Error {
  constructor() {
    super("Simulator leases are disabled by owner policy");
    this.name = "SimulatorsDisabledError";
  }
}
function groupAlive(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid < 2) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** Matches LEFTOVER_GRACE_SECONDS in native.py: leftovers get this long after their command exits. */
const LEFTOVER_GRACE_MS = 10_000;
/**
 * When a lease's command exited (or its runner died) with members left in its group. Kept
 * beside the journal, not in it, so strict readers of an older journal schema still parse it.
 */
function leftoverMarker(directory: string, id: string): string {
  return join(directory, "leftovers", `${basename(id)}.json`);
}
/** Display metadata only: never supplies exit, signal or admission authority. */
function serverCpuStatus(directory: string, lease: HeavyLease): { cpuLimitUnenforcedSinceMs?: number } {
  if (!lease.runner) return {};
  try {
    const status = JSON.parse(readFileSync(join(directory, "cpu", `${basename(lease.id)}.json`), "utf8")) as {
      pid?: unknown;
      startTime?: unknown;
      sinceMs?: unknown;
    };
    if (
      status.pid === lease.runner.pid &&
      status.startTime === lease.runner.startTime &&
      typeof status.sinceMs === "number" &&
      Number.isSafeInteger(status.sinceMs) &&
      status.sinceMs >= 0
    )
      return { cpuLimitUnenforcedSinceMs: status.sinceMs };
  } catch {
    // Missing or unverified metadata says nothing about an individual process.
  }
  return {};
}
function leftoversSince(directory: string, id: string): number | undefined {
  try {
    const value = (
      JSON.parse(readFileSync(leftoverMarker(directory, id), "utf8")) as { commandExitedAtMs?: unknown }
    ).commandExitedAtMs;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
function markLeftovers(directory: string, id: string, at: number): void {
  mkdirSync(join(directory, "leftovers"), { recursive: true, mode: 0o700 });
  const path = leftoverMarker(directory, id);
  writeFileSync(`${path}.tmp`, JSON.stringify({ commandExitedAtMs: at }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
/** Markers outlive nothing: drop any whose lease has left the journal. */
function pruneLeftoverMarkers(directory: string, leases: readonly { id: string }[]): void {
  let names: string[];
  try {
    names = readdirSync(join(directory, "leftovers"));
  } catch {
    return;
  }
  const live = new Set(leases.map((lease) => `${basename(lease.id)}.json`));
  for (const name of names)
    if (!live.has(name) && name.endsWith(".json"))
      rmSync(join(directory, "leftovers", name), { force: true });
}
/** Groups this process is already stopping; another pass must not start a second stopper. */
const stoppingGroups = new Set<number>();
/**
 * A dead runner can't stop its own leftovers, so the reaper does (VUH-2027). The group ID
 * cannot be reused while it has members, so it remains this lease's authority. Runs outside
 * the registry lock; a later reconcile drops the lease once the group is empty.
 */
function stopLeftovers(directory: string, lease: HeavyLease, pgid: number, since: number): void {
  if (stoppingGroups.has(pgid)) return;
  stoppingGroups.add(pgid);
  const record = {
    id: lease.id,
    // The member-binding authority: each stopped process must be born since this runner.
    runner: lease.runner,
    executable: lease.executable,
    ...(lease.seatId ? { seatId: lease.seatId } : {}),
    ...(lease.holderId ? { holderId: lease.holderId } : {}),
    commandExitedAtMs: since,
  };
  const child = spawn(
    resourcePython,
    ["-I", resourceNativeHelperPath(), "stop-leftovers", directory, String(pgid)],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  child.once("error", () => stoppingGroups.delete(pgid));
  child.once("exit", () => stoppingGroups.delete(pgid));
  child.stdin.end(`${JSON.stringify(record)}\n`);
  child.unref();
}
function matches(a: ProcessIdentity | undefined, b: ProcessIdentity): boolean {
  return a?.pid === b.pid && a.startTime === b.startTime;
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abort());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", cancelled);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const cancelled = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      reject(abort());
    };
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}
/** How often a waiting heavy command peeks at the journal without the lock. */
const PEEK_MS = 500;
/** How often a waiter takes the lock anyway, so dead holders are reconciled. */
const FULL_PASS_MS = 5_000;
/** Spread waiters so they do not wake together. */
const jittered = (ms: number) => Math.round(ms * (0.6 + Math.random() * 0.8));
/** One canonical machine registry; runtime/worktree environment cannot increase capacity. */
export function createResourceGovernor(
  options: {
    directory?: string;
    simulatorBootSettleMs?: number;
    /** Host-owned original native registrations may connect detached harness servers to their seat. Never caller labels. */
    nativeSimulatorOwner?: (
      owner: SimulatorReservation,
      ancestors: readonly ProcessIdentity[],
    ) => Promise<boolean>;
  } = {},
): FleetResourceGovernor {
  const bootSettleMs = options.simulatorBootSettleMs ?? simulatorBootSettleMs;
  const directory = options.directory ?? join(userInfo().homedir, ".clankie/fleet-resources");
  // A disposable local hint, never lease authority. Ordinary Claude hooks can
  // skip Node and HTTP entirely when their pane has no root lease.
  const rootHookHint = (lease: SimulatorReservation, clear = false) => {
    if (
      !lease.holderId?.match(/^claude:[A-Za-z0-9_-]+$/u) ||
      !lease.pane?.match(/^[A-Za-z0-9:_-]+$/u) ||
      !lease.binding?.socketPath ||
      lease.binding.socketPath.split(/[\\/]/u).includes("..")
    )
      return;
    const path = join(directory, "root-hook-leases", lease.binding.socketPath, lease.pane);
    try {
      if (clear) {
        if (readFileSync(path, "utf8") === lease.holderId) rmSync(path, { force: true });
      } else {
        mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(path, lease.holderId, { mode: 0o600 });
      }
    } catch {
      // A missing hint loses renewal only; the normal lease deadline still applies.
    }
  };
  const retrying = {
    // Bounded causes only (stage and errno); never journal contents or paths.
    onRetry: (error: Error, attempt: number) =>
      process.stderr.write(
        `clankie: retrying a fleet resource transaction (${attempt}/2): ${error.message}\n`,
      ),
  };
  const store = new ResourceStore(directory, retrying);
  // The light lane is its own journal, so installs that predate it never read
  // a lease shape they do not know. Its policy comes from the main journal.
  const lightStore = new ResourceStore(join(directory, "light"), retrying);
  const serverStore = new ResourceStore(join(directory, "server"), retrying);
  const mainStore = store;
  const laneStore = (lane: HeavyJobLane) =>
    lane === "server" ? serverStore : lane === "light" ? lightStore : store;
  const shutdown = new AbortController();
  const active = new Set<Promise<unknown>>();
  // Heavy leases whose runner is proven dead while group members survive.
  const orphaned = new Set<string>();
  /** Process facts gathered before a transaction, so no fork runs under the lock. */
  type Seen = {
    observations: Awaited<ReturnType<typeof observeProcesses>>;
    groups: Map<number, boolean>;
  };
  const watchedPids = (state: ResourceState) => [
    ...state.queue.map((entry) => entry.owner.pid),
    ...state.leases.flatMap((lease) =>
      lease.kind !== "heavy"
        ? []
        : lease.state === "starting"
          ? [lease.claimOwner.pid]
          : lease.runner
            ? [lease.runner.pid]
            : [],
    ),
  ];
  /**
   * Observe the journal's processes from a lock-free read (VUH-2053). Every
   * queued client used to fork these censuses while holding the registry lock,
   * starving the service. An exit is permanent for an exact PID and start
   * time, so a fact read before the lock can only retain a lease longer; a PID
   * the read missed is unknown and retained.
   */
  async function look(from: ResourceStore): Promise<Seen> {
    const seen: Seen = { observations: new Map(), groups: new Map() };
    const state = await from.read().catch(() => undefined);
    if (!state) return seen;
    const pids = watchedPids(state);
    if (!pids.length) return seen;
    seen.observations = await observeProcesses(pids).catch(() => new Map());
    for (const lease of state.leases) {
      if (lease.kind !== "heavy" || lease.state === "starting" || !lease.runner) continue;
      const observation = seen.observations.get(lease.runner.pid);
      if (!observation || observation.status === "unknown") continue;
      const root = observation.status === "live" ? observation.identity : undefined;
      if (matches(root, lease.runner) || (root && root.pgid === root.pid)) continue;
      try {
        seen.groups.set(lease.runner.pgid, await groupOccupied(lease.runner.pgid));
      } catch {
        // Unknown occupancy retains the lease.
      }
    }
    return seen;
  }
  async function reconcile(state: ResourceState, seen: Seen, leaseDirectory = directory): Promise<void> {
    if (!state.leases.some((lease) => lease.kind === "heavy") && state.queue.length === 0) return;
    const previousIds = new Set(state.leases.map((lease) => lease.id));
    // This state and its exact recorded PIDs belong to the held OS lock; the
    // facts about them were observed just before it, never under it.
    const observe = (proof: ProcessIdentity) => {
      const observation = seen.observations.get(proof.pid);
      if (!observation || observation.status === "unknown") throw new Error("Process identity unavailable");
      return observation.status === "live" ? observation.identity : undefined;
    };
    const queue = [];
    for (const entry of state.queue) {
      if (entry.simulator && entry.simulator.expiresAtMs <= Date.now()) continue;
      try {
        if (matches(observe(entry.owner), entry.owner)) queue.push(entry);
      } catch {
        queue.push(entry);
      }
    }
    state.queue = queue;
    const retained: ResourceState["leases"] = [];
    const reaped: ReapReceipt[] = [];
    for (const lease of state.leases) {
      if (lease.kind === "simulator") {
        retained.push(lease);
        continue;
      }
      try {
        if (lease.state === "starting") {
          // The runner checks this same identity while holding this OS lock.
          // A dead owner therefore cannot have an unregistered future launch.
          if (matches(observe(lease.claimOwner), lease.claimOwner)) retained.push(lease);
          else reaped.push(reapReceipt(lease, "claim_owner_exited", lease.claimOwner.pid));
          continue;
        }
        if (!lease.runner) {
          retained.push(lease);
          continue;
        }
        const root = observe(lease.runner);
        if (matches(root, lease.runner)) {
          retained.push(lease);
          continue;
        }
        // The original process group ended before a reused PID became a new
        // group leader; that is not authority to signal the new process.
        // Otherwise a dead runner can leave living descendants in its group:
        // they keep the permit until a census proves no live member remains
        // (zombies do not count). The runner's own settlement cannot happen,
        // so this reconciliation is what frees the slot (VUH-2006).
        const occupied = root && root.pgid === root.pid ? false : seen.groups.get(lease.runner.pgid);
        if (occupied === undefined) throw new Error("Process group observation unavailable");
        if (occupied) {
          orphaned.add(lease.id);
          // Nobody else will ever stop these leftovers: after the grace, the reaper
          // does, and a later pass releases the lease once the census is empty (VUH-2027).
          let since = leftoversSince(leaseDirectory, lease.id);
          if (since === undefined) markLeftovers(leaseDirectory, lease.id, (since = Date.now()));
          if (Date.now() - since >= LEFTOVER_GRACE_MS)
            stopLeftovers(leaseDirectory, lease, lease.runner.pgid, since);
          retained.push(lease);
          continue;
        }
        reaped.push(reapReceipt(lease, "runner_exited", lease.runner.pid));
      } catch {
        retained.push(lease);
      }
    }
    state.leases = retained;
    pruneLeftoverMarkers(leaseDirectory, retained);
    for (const id of orphaned)
      if (previousIds.has(id) && !retained.some((lease) => lease.id === id)) orphaned.delete(id);
    if (reaped.length) await recordReaped(reaped, leaseDirectory);
  }
  /** Kernel group existence, confirmed by a census that excludes zombies; failures retain. */
  async function groupOccupied(pgid: number): Promise<boolean> {
    if (!groupAlive(pgid)) return false;
    return processGroupOccupied(pgid);
  }
  type ReapReceipt = ReturnType<typeof reapReceipt>;
  function reapReceipt(lease: HeavyLease, reason: "claim_owner_exited" | "runner_exited", pid: number) {
    return {
      reapedAtMs: Date.now(),
      leaseId: lease.id,
      kind: lease.kind,
      reason,
      pid,
      executable: lease.executable,
      ...(lease.seatId ? { seatId: lease.seatId } : {}),
      ...(lease.holderId ? { holderId: lease.holderId } : {}),
      createdAtMs: lease.createdAtMs,
    };
  }
  /** Append-only beside the journal, so older readers of the strict journal are unaffected. */
  async function recordReaped(
    receipts: readonly (ReapReceipt | SimulatorSettledReceipt)[],
    leaseDirectory = directory,
    name = "reaped.jsonl",
  ): Promise<void> {
    await appendRecords(leaseDirectory, name, receipts);
  }
  async function project(
    state: ResourceState,
    light?: ResourceState,
    server?: ResourceState,
  ): Promise<ResourceSnapshot> {
    light ??= await lightStore.read();
    server ??= await serverStore.read();
    const serverCapacity = serverLaneCapacity();
    const usage = state.leases.some((lease) => lease.kind === "simulator" && lease.deviceId)
      ? await observeSimulatorUsage()
      : new Map();
    // allow-swallowed-rejection -- an unreadable volume leaves the disk reading out; nothing gates on it.
    const volume = await statfs(directory).catch(() => undefined);
    const free = volume && (volume.bavail * volume.bsize) / 1024 ** 3;
    const total = volume && (volume.blocks * volume.bsize) / 1024 ** 3;
    const disk =
      free !== undefined && total
        ? {
            freeDiskGb: free,
            totalDiskGb: total,
            warning:
              free < state.policy.warnFreeDiskGb || (free / total) * 100 < state.policy.warnFreeDiskPercent,
          }
        : undefined;
    return {
      schemaVersion: 1,
      policy: state.policy,
      capacity: {
        heavySlots: resourceCapacity(state.policy),
        simulatorSlots: state.policy.simulatorSlots,
        used: state.leases.filter((lease) => lease.kind === "heavy").length,
        simulatorUsed: state.leases.filter((lease) => lease.kind === "simulator").length,
        lightSlots: baseHeavySlots(state.policy),
        lightUsed: light.leases.length,
        serverSlots: serverCapacity.slots,
        serverUsed: server.leases.length,
        serverCpuCores: serverCapacity.cpuCores,
      },
      // A plain machine reading, always healthy: nothing gates on it since #599. Its shape
      // is the old one because clients built earlier (the installed app, older CLIs)
      // require it and reject unknown keys.
      pressure: {
        sampledAtMs: Date.now(),
        loadRatio: loadavg()[0]! / availableParallelism(),
        availableMemoryMb: freemem() / 1024 ** 2,
        ...(disk
          ? { freeDiskGb: disk.freeDiskGb, totalDiskGb: disk.totalDiskGb, diskWarning: disk.warning }
          : {}),
        healthy: true,
      },
      serverLeases: server.leases.flatMap((lease) =>
        lease.kind === "heavy"
          ? [
              {
                id: lease.id,
                state: orphaned.has(lease.id)
                  ? "orphaned"
                  : leftoversSince(serverStore.directory, lease.id) !== undefined
                    ? "leftovers"
                    : lease.state,
                ...(lease.seatId ? { seatId: lease.seatId } : {}),
                ...(lease.holderId ? { holderId: lease.holderId } : {}),
                executable: lease.executable,
                createdAtMs: lease.createdAtMs,
                cpuCores: serverCapacity.jobCpuCores,
                ...serverCpuStatus(serverStore.directory, lease),
                ...(lease.runner ? { pid: lease.runner.pid } : {}),
              },
            ]
          : [],
      ),
      serverQueue: server.queue.map(({ id, seatId, holderId, executable, queuedAtMs, owner }) => ({
        id,
        ...(seatId ? { seatId } : {}),
        ...(holderId ? { holderId } : {}),
        ...(executable ? { executable } : {}),
        queuedAtMs,
        pid: owner.pid,
      })),
      holderAlerts: (
        [
          { lane: "full", state },
          { lane: "light", state: light },
          { lane: "server", state: server },
        ] as const
      ).flatMap(({ lane, state: from }) =>
        from.leases.flatMap((lease) =>
          lease.kind === "heavy" && (lane === "server" || Date.now() - lease.createdAtMs >= longHeldJobMs)
            ? [
                {
                  id: lease.id,
                  lane,
                  reason: lane === "server" ? ("server" as const) : ("long-held" as const),
                  ...(lease.seatId ? { seatId: lease.seatId } : {}),
                  ...(lease.holderId ? { holderId: lease.holderId } : {}),
                  executable: lease.executable,
                  createdAtMs: lease.createdAtMs,
                  ...(lease.runner ? { pid: lease.runner.pid } : {}),
                },
              ]
            : [],
        ),
      ),
      leases: state.leases.map((lease) => ({
        id: lease.id,
        kind: lease.kind,
        // `orphaned`: its runner died with members left; `leftovers`: its command exited
        // and only leftovers hold the slot (VUH-2006, VUH-2027).
        state:
          lease.kind === "heavy"
            ? orphaned.has(lease.id)
              ? "orphaned"
              : leftoversSince(directory, lease.id) !== undefined
                ? "leftovers"
                : lease.state
            : lease.phase,
        ...(lease.seatId ? { seatId: lease.seatId } : {}),
        ...(lease.holderId ? { holderId: lease.holderId } : {}),
        ...(lease.kind === "heavy"
          ? { executable: lease.executable }
          : lease.deviceId
            ? { deviceId: lease.deviceId, usage: simulatorUsageFor(usage, lease.deviceId) }
            : {}),
        createdAtMs: lease.createdAtMs,
        lastUsedAtMs: lease.lastUsedAtMs,
        ...(lease.kind === "heavy" && lease.runner ? { pid: lease.runner.pid } : {}),
      })),
      lightLeases: light.leases.flatMap((lease) =>
        lease.kind === "heavy"
          ? [
              {
                id: lease.id,
                state: lease.state,
                ...(lease.seatId ? { seatId: lease.seatId } : {}),
                ...(lease.holderId ? { holderId: lease.holderId } : {}),
                executable: lease.executable,
                createdAtMs: lease.createdAtMs,
                ...(lease.runner ? { pid: lease.runner.pid } : {}),
              },
            ]
          : [],
      ),
      lightQueue: light.queue.map(({ id, seatId, holderId, executable, queuedAtMs, owner }) => ({
        id,
        ...(seatId ? { seatId } : {}),
        ...(holderId ? { holderId } : {}),
        ...(executable ? { executable } : {}),
        queuedAtMs,
        pid: owner.pid,
      })),
      queue: state.queue.map(
        ({ id, kind, seatId, executable, queuedAtMs, owner, holderId, simulator }, index) => ({
          id,
          kind,
          ...(seatId ? { seatId } : {}),
          ...(executable ? { executable } : {}),
          queuedAtMs,
          pid: owner.pid,
          ...(holderId ? { holderId } : {}),
          ...(simulator
            ? {
                ...((simulator.targetDeviceId ?? simulator.deviceId)
                  ? { deviceId: simulator.targetDeviceId ?? simulator.deviceId }
                  : {}),
                ...(simulator.deviceType ? { deviceType: simulator.deviceType } : {}),
                ...(simulator.runtime ? { runtime: simulator.runtime } : {}),
                exact: simulator.exact,
                expiresAtMs: simulator.expiresAtMs,
                position: state.queue
                  .slice(0, index + 1)
                  .filter((entry) => entry.simulator && sameQueue(entry.simulator, simulator)).length,
                // Idle-timeout heuristic, not a promised release: heartbeats can extend it.
                estimatedWaitMs: (() => {
                  const leases = state.leases.filter(
                    (lease): lease is SimulatorReservation => lease.kind === "simulator",
                  );
                  const held = leases.find((lease) => lease.deviceId === simulator.targetDeviceId);
                  const ahead = state.queue
                    .slice(0, index)
                    .filter((entry) => entry.simulator && sameQueue(entry.simulator, simulator)).length;
                  if (held)
                    return (
                      Math.max(0, held.lastUsedAtMs + state.policy.simulatorIdleMs - Date.now()) +
                      ahead * state.policy.simulatorIdleMs
                    );
                  return leases.length < state.policy.simulatorSlots && !ahead ? 0 : null;
                })(),
              }
            : {}),
        }),
      ),
    };
  }
  async function reconciled(from: ResourceStore): Promise<ResourceState> {
    const state = await from.read();
    if (!state.leases.some((lease) => lease.kind === "heavy") && !state.queue.length) return state;
    const seen = await look(from);
    return from.transaction(async (current) => {
      await reconcile(current, seen, from.directory);
      return structuredClone(current);
    });
  }
  async function snapshot() {
    return project(await reconciled(store), await reconciled(lightStore), await reconciled(serverStore));
  }
  function heavyHead(state: ResourceState) {
    return state.queue.find((entry) => entry.kind === "heavy");
  }
  /** Each lane is a FIFO of this many permits: the owner's heavy slots, light slots, server slots. */
  function laneSlots(lane: HeavyJobLane, policy: FleetResourcePolicy): number {
    if (lane === "server") return serverLaneCapacity().slots;
    return lane === "light" ? baseHeavySlots(policy) : resourceCapacity(policy);
  }
  /** A lease for a queued request, carrying that waiter's own identity and token. */
  function grant(state: ResourceState, entry: ResourceQueueEntry): HeavyLease {
    const at = Date.now();
    const lease: HeavyLease = {
      id: entry.id,
      token: entry.token,
      kind: "heavy",
      state: "starting",
      claimOwner: entry.owner,
      executable: entry.executable ?? "unknown",
      ...(entry.seatId ? { seatId: entry.seatId } : {}),
      ...(entry.holderId ? { holderId: entry.holderId } : {}),
      createdAtMs: at,
      lastUsedAtMs: at,
    };
    state.queue = state.queue.filter((queued) => queued.id !== entry.id);
    state.leases.push(lease);
    return lease;
  }
  /**
   * Waits in this lane's FIFO and takes a permit when this ticket is the head
   * and a slot is free (#599). No machine reading gates it; dead holders are
   * reconciled on every locked pass, so their slots come back.
   */
  async function acquire(
    options: ResourceWaitOptions & {
      seatId?: string;
      holderId?: string;
      executable: string;
      lane: HeavyJobLane;
    },
  ): Promise<HeavyLease> {
    const store = laneStore(options.lane);
    const owner = await processIdentity();
    if (!owner) throw new Error("Fleet resource process identity unavailable");
    const signal = options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal;
    if (signal.aborted) throw abort();
    if (options.seatId && (options.seatId.length > 256 || options.seatId.includes("\0")))
      throw new Error("Invalid fleet seat identity");
    if (options.holderId && (options.holderId.length > 256 || /\p{Cc}/u.test(options.holderId)))
      throw new Error("Invalid fleet holder identity");
    const id = randomUUID(),
      token = randomUUID();
    const seen = await look(store);
    await store.transaction(
      async (state) => {
        await reconcile(state, seen, store.directory);
        if (state.queue.length >= 512) throw new Error("Fleet resource queue is full");
        state.queue.push({
          id,
          token,
          kind: "heavy",
          owner,
          queuedAtMs: Date.now(),
          ...(options.seatId ? { seatId: options.seatId } : {}),
          ...(options.holderId ? { holderId: options.holderId } : {}),
          executable: options.executable,
        });
      },
      { signal },
    );
    let admitted = false;
    // The owner's policy lives in the main journal for every lane.
    const policyFor = async (state: ResourceState) =>
      options.lane !== "full" ? (await mainStore.read()).policy : state.policy;
    const admits = (state: ResourceState, policy: FleetResourcePolicy) =>
      heavyHead(state)?.id === id &&
      state.leases.filter((lease) => lease.kind === "heavy").length < laneSlots(options.lane, policy);
    /** A lease granted to this request, by this waiter or, before #599, by a service arbiter. */
    const mine = (state: ResourceState) =>
      state.leases.find(
        (lease): lease is HeavyLease => lease.kind === "heavy" && lease.id === id && lease.token === token,
      );
    let fullPassAt = Date.now() + jittered(FULL_PASS_MS);
    let reportedAt = 0;
    const report = async (state: ResourceState) => {
      if (!options.onWait || Date.now() - reportedAt < FULL_PASS_MS) return;
      reportedAt = Date.now();
      options.onWait(
        options.lane === "server"
          ? await project(await mainStore.read(), undefined, state)
          : options.lane === "light"
            ? await project(await mainStore.read(), state)
            : await project(state),
      );
    };
    try {
      for (;;) {
        if (signal.aborted) throw abort();
        const peek = await store.read().catch(() => undefined);
        const granted = peek && mine(peek);
        if (granted) {
          admitted = true;
          return structuredClone(granted);
        }
        // Waiters take the registry lock only when they could be admitted, or
        // on a jittered full pass that reconciles dead holders (VUH-2053).
        const due = Date.now() >= fullPassAt;
        if (peek && !due && !admits(peek, await policyFor(peek))) {
          await report(peek);
          await wait(jittered(PEEK_MS), signal);
          continue;
        }
        if (due) fullPassAt = Date.now() + jittered(FULL_PASS_MS);
        const seen = await look(store);
        let advisory: ResourceState | undefined;
        const lease = await store.transaction(
          async (state) => {
            await reconcile(state, seen, store.directory);
            const already = mine(state);
            if (already) return structuredClone(already);
            if (!admits(state, await policyFor(state))) {
              advisory = structuredClone(state);
              return undefined;
            }
            if (signal.aborted) throw abort();
            const head = state.queue.find((entry) => entry.id === id)!;
            return structuredClone(grant(state, head));
          },
          { signal },
        );
        if (lease) {
          admitted = true;
          return lease;
        }
        // Advisory status from the same attempt, projected after the
        // transaction commits; publishing a wait must not acquire another lock.
        if (advisory) await report(advisory);
        await wait(jittered(PEEK_MS), signal);
      }
    } finally {
      if (!admitted)
        await store.transaction((state) => {
          state.queue = state.queue.filter((entry) => entry.id !== id || entry.token !== token);
          // A grant this waiter never took up is returned with its ticket.
          state.leases = state.leases.filter(
            (lease) =>
              lease.kind !== "heavy" ||
              lease.id !== id ||
              lease.token !== token ||
              lease.state !== "starting",
          );
        });
    }
  }
  async function inherited(holderId?: string): Promise<(HeavyLease & { lane: HeavyJobLane }) | undefined> {
    let ref: { id?: string; token?: string };
    try {
      ref = JSON.parse(process.env.CLANKIE_RESOURCE_LEASE ?? "null") ?? {};
    } catch {
      return undefined;
    }
    const found = (entry: ResourceState["leases"][number]): entry is HeavyLease =>
      entry.kind === "heavy" && entry.id === ref.id && entry.token === ref.token;
    let lane: HeavyJobLane = "full";
    let lease = (await store.read()).leases.find(found);
    if (!lease) {
      lane = "light";
      lease = (await lightStore.read()).leases.find(found);
    }
    if (!lease) {
      lane = "server";
      lease = (await serverStore.read()).leases.find(found);
    }
    if (!lease?.runner || lease.state !== "running") return undefined;
    // A native child in the same group is a distinct holder, not nested work
    // belonging to the parent that acquired this permit.
    if (holderId !== undefined && holderId !== lease.holderId) return undefined;
    const mine = await processIdentity();
    if (!mine || mine.pgid !== lease.runner.pgid || mine.uid !== lease.runner.uid) return undefined;
    const root = await processIdentity(lease.runner.pid);
    if (root && !matches(root, lease.runner)) return undefined;
    return { ...lease, lane };
  }
  async function runHeavy(
    command: string,
    args: readonly string[],
    options: HeavyRunOptions = {},
  ): Promise<number> {
    if (!command || command.includes("\0") || args.some((arg) => arg.includes("\0")))
      throw new Error("Invalid heavy command");
    const interrupted = new AbortController();
    const onInt = () => interrupted.abort("SIGINT"),
      onTerm = () => interrupted.abort("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const signal = AbortSignal.any([
      shutdown.signal,
      interrupted.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    let lease: HeavyLease | undefined;
    let record: Omit<Parameters<typeof recordLease>[1], "event"> | undefined;
    let exitCode: number | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const lane = options.server ? "server" : heavyJobLane(command, args);
    const store = laneStore(lane);
    try {
      const parentLease = await inherited(options.holderId);
      if (signal.aborted) throw abort();
      // A server must not borrow a bounded parent permit; it needs the CPU
      // supervisor and its own lifetime in the independent lane.
      if (parentLease && (lane !== "server" || parentLease.lane === "server")) {
        child = spawn(
          command,
          heavyJobArgs(command, args, lane === "full" ? heavyJobParallelism : lightJobParallelism),
          {
            stdio: [
              options.input !== undefined ? "pipe" : "inherit",
              options.stdout ? "pipe" : "inherit",
              options.stderr ? "pipe" : "inherit",
            ],
            env: heavyJobEnvironment(options.env ?? process.env),
            cwd: options.cwd,
          },
        );
        if (options.input !== undefined) child.stdin!.end(options.input);
        if (options.stdout) child.stdout!.pipe(options.stdout, { end: false });
        if (options.stderr) child.stderr!.pipe(options.stderr, { end: false });
        const done = new Promise<number>((resolve, reject) => {
          child!.once("error", () => reject(new Error("Heavy command could not start")));
          child!.once("close", (code, sig) => resolve(code ?? (sig ? 128 + constants.signals[sig] : 1)));
        });
        const birth = child.pid ? await processIdentity(child.pid) : undefined;
        const cancel = () => {
          if (birth)
            void processIdentity(birth.pid)
              .then((current) => {
                if (child?.exitCode === null && matches(current, birth))
                  child.kill(interrupted.signal.reason === "SIGINT" ? "SIGINT" : "SIGTERM");
              })
              .catch(() => undefined);
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        try {
          return await done;
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      }
      const requestedAt = Date.now();
      lease = await acquire({
        ...options,
        signal,
        lane,
        executable: basename(command).slice(0, 128),
      });
      record = {
        leaseId: lease.id,
        lane,
        ...(lease.holderId ? { holderId: lease.holderId } : {}),
        ...(lease.seatId ? { seatId: lease.seatId } : {}),
        command: leaseCommand(command, args),
      };
      await recordLease(directory, {
        ...record,
        event: "admitted",
        waitedMs: lease.createdAtMs - requestedAt,
      });
      if (signal.aborted) throw abort();
      child = spawn(
        resourcePython,
        ["-I", resourceNativeHelperPath(), "run", store.directory, lease.id, lease.token],
        {
          detached: true,
          stdio: [
            "inherit",
            options.stdout ? "pipe" : "inherit",
            options.stderr ? "pipe" : "inherit",
            "pipe",
            "pipe",
          ],
          env: heavyJobEnvironment(
            options.env ?? process.env,
            lane === "server"
              ? serverJobParallelism
              : lane === "light"
                ? lightJobParallelism
                : heavyJobParallelism,
          ),
        },
      );
      if (options.stdout) child.stdout!.pipe(options.stdout, { end: false });
      if (options.stderr) child.stderr!.pipe(options.stderr, { end: false });
      const done = new Promise<number>((resolve, reject) => {
        child!.once("error", () => reject(new Error("Fleet heavy runner requires Python 3")));
        child!.once("close", (code, sig) => resolve(code ?? (sig ? 128 + constants.signals[sig] : 1)));
      });
      void done.catch(() => undefined);
      const input = child.stdio[3] as Writable;
      const replies = createInterface({ input: child.stdio[4] as Readable });
      const first = replies[Symbol.asyncIterator]().next();
      input.write(
        `${JSON.stringify({
          command,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.input !== undefined ? { input: options.input } : {}),
          args: heavyJobArgs(command, args, lane === "full" ? heavyJobParallelism : lightJobParallelism),
          ...(lane === "server" ? { serverCpuCores: serverLaneCapacity().jobCpuCores } : {}),
        })}\n`,
      );
      const cancelRegistration = () => {
        input.end();
      };
      signal.addEventListener("abort", cancelRegistration, { once: true });
      if (signal.aborted) cancelRegistration();
      let ready: Awaited<typeof first>;
      try {
        ready = await Promise.race([
          first,
          done.then(() => {
            throw new Error("Fleet heavy runner did not register");
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", cancelRegistration);
      }
      replies.close();
      if (ready.done) throw new Error("Fleet heavy runner did not register");
      const runner = JSON.parse(ready.value) as ProcessIdentity;
      if (runner.pid !== child.pid || !matches(await processIdentity(runner.pid), runner))
        throw new Error("Fleet heavy runner lifetime changed");
      const sendSignal = async (sig: "SIGINT" | "SIGTERM" | "SIGKILL") => {
        if (matches(await processIdentity(runner.pid), runner)) {
          process.kill(-runner.pgid, sig);
          if (lane === "server" && sig !== "SIGKILL") process.kill(-runner.pgid, "SIGCONT");
        }
      };
      // The KILL grace starts once TERM has gone out: TERM first waits on an
      // identity read, which under load can outlast the grace itself (#372).
      // A failed read still arms it, and KILL re-checks the identity.
      const cancel = () => {
        void sendSignal(interrupted.signal.reason === "SIGINT" ? "SIGINT" : "SIGTERM")
          .catch(() => undefined)
          .then(() => {
            if (settled) return;
            killTimer = setTimeout(() => {
              void sendSignal("SIGKILL").catch(() => undefined);
            }, 2_000);
          });
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) {
        input.end();
        cancel();
      } else input.write("go\n");
      try {
        return (exitCode = await done);
      } finally {
        signal.removeEventListener("abort", cancel);
        input.end();
      }
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError"))
        return interrupted.signal.reason === "SIGTERM" ? 143 : 130;
      throw error;
    } finally {
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      if (lease && record)
        await recordLease(directory, {
          ...record,
          event: "released",
          heldMs: Date.now() - lease.createdAtMs,
          ...(exitCode === undefined ? {} : { exitCode }),
        });
      if (lease) {
        const seen = await look(store);
        await store.transaction(async (state) => {
          await reconcile(state, seen, store.directory);
        });
      }
    }
  }
  /**
   * A light permit this process holds around its own work. The lease stays
   * `starting` with this process as its claim owner and never gains a runner,
   * so reconciliation reaps it if this process dies (`claim_owner_exited`) and
   * no process group is ever signalled for it.
   */
  async function holdLight<T>(
    options: ResourceWaitOptions & { holderId: string; operation: string },
    work: () => Promise<T>,
  ): Promise<T> {
    const requestedAt = Date.now();
    const lease = await acquire({
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onWait ? { onWait: options.onWait } : {}),
      holderId: options.holderId,
      executable: options.operation.slice(0, 128),
      lane: "light",
    });
    const record = {
      leaseId: lease.id,
      lane: "light" as const,
      holderId: options.holderId,
      command: options.operation.slice(0, 256),
    };
    await recordLease(directory, { ...record, event: "admitted", waitedMs: lease.createdAtMs - requestedAt });
    let exitCode = 1;
    try {
      const result = await work();
      exitCode = 0;
      return result;
    } finally {
      await lightStore.transaction((state) => {
        state.leases = state.leases.filter(
          (held) => held.kind !== "heavy" || held.id !== lease.id || held.token !== lease.token,
        );
      });
      await recordLease(directory, {
        ...record,
        event: "released",
        heldMs: Date.now() - lease.createdAtMs,
        exitCode,
      });
    }
  }
  return {
    async configure(policy: FleetResourcePolicy, options) {
      const parsed = FleetResourcePolicySchema.parse(policy);
      const state = await store.transaction(
        (current) => {
          options?.beforeWrite?.();
          current.policy = parsed;
          return structuredClone(current);
        },
        options?.signal ? { signal: options.signal } : {},
      );
      return project(state);
    },
    snapshot,
    restartGuard: (owner) =>
      proveRestartResources(owner, () => Promise.all([store.read(), lightStore.read(), serverStore.read()])),
    runHeavy(command, args, options) {
      const job = runHeavy(command, args, options);
      active.add(job);
      void job.finally(() => active.delete(job)).catch(() => undefined);
      return job;
    },
    holdLight(options, work) {
      const job = holdLight(options, work);
      active.add(job);
      // allow-swallowed-rejection -- the caller awaits `job` and gets its error; this copy only tracks it for close().
      void job.finally(() => active.delete(job)).catch(() => undefined);
      return job;
    },
    async queueSimulator(options) {
      const proof = options.ownerProcesses?.[0];
      const owner = proof && (await processIdentity(proof.pid));
      if (!owner || owner.startTime !== proof?.startTime || !options.holderId)
        throw new Error("Simulator ticket owner unavailable");
      const seen = await look(store);
      return store.transaction(async (state) => {
        await reconcile(state, seen);
        const existing = state.queue.find((entry) => ticketOwner(entry, options));
        if (options.ticketId && existing?.id !== options.ticketId)
          throw new Error("Simulator ticket unavailable");
        if (existing) {
          const selection = existing.simulator!;
          if (
            selection.deviceId !== options.selection.deviceId ||
            selection.deviceType !== options.selection.deviceType ||
            selection.runtime !== options.selection.runtime ||
            selection.exact !== options.selection.exact
          )
            throw new Error("Simulator ticket selection changed; cancel it first");
          selection.expiresAtMs = Date.now() + 300_000;
          if (!selection.targetDeviceId && options.selection.targetDeviceId)
            selection.targetDeviceId = options.selection.targetDeviceId;
          return structuredClone(existing);
        }
        if (state.queue.length >= 512) throw new Error("Fleet resource queue is full");
        const ticket: ResourceQueueEntry = {
          id: randomUUID(),
          token: randomUUID(),
          kind: "simulator",
          seatId: options.seatId,
          holderId: options.holderId!,
          owner,
          queuedAtMs: Date.now(),
          simulator: {
            ...options.selection,
            occupantId: options.occupantId,
            ...(options.fleet ? { fleet: options.fleet } : {}),
            expiresAtMs: Date.now() + 300_000,
          },
        };
        state.queue.push(ticket);
        return structuredClone(ticket);
      });
    },
    async cancelSimulatorTicket(id, owner) {
      return store.transaction((state) => {
        const ticket = state.queue.find((entry) => entry.id === id && ticketOwner(entry, owner));
        if (!ticket) return false;
        state.queue = state.queue.filter((entry) => entry.id !== ticket.id);
        return true;
      });
    },
    async tryAcquireSimulator(options) {
      if (
        !options.seatId ||
        !options.occupantId ||
        (options.holderId !== undefined &&
          (!options.holderId || options.holderId.length > 256 || /\p{Cc}/u.test(options.holderId))) ||
        options.occupantId.length > 512 ||
        (options.ownerProcesses?.length ?? 0) > 32
      )
        throw new Error("Simulator requires an exact named seat owner");
      if (shutdown.signal.aborted) throw abort();
      let refusal: { reason: SimulatorBlock; state: ResourceState } | undefined;
      const seen = await look(store);
      const lease = await store.transaction(async (state) => {
        await reconcile(state, seen);
        if (state.policy.simulatorSlots === 0) throw new SimulatorsDisabledError();
        const blocked = (reason: SimulatorBlock) => {
          refusal = { reason, state: structuredClone(state) };
          return undefined;
        };
        if (options.ticketId) {
          const index = state.queue.findIndex(
            (entry) => entry.id === options.ticketId && ticketOwner(entry, options),
          );
          if (index < 0) throw new Error("Simulator ticket unavailable");
          const ticket = state.queue[index]!;
          if (
            ticket.simulator?.targetDeviceId &&
            options.deviceId?.toUpperCase() !== ticket.simulator.targetDeviceId
          )
            throw new Error("Simulator ticket target changed");
          // A freed slot goes to the oldest ticket waiting for a slot, whatever
          // device it names (VUH-2008). An older ticket whose device another
          // lease holds waits for that device, so other devices proceed.
          const leased = new Set(
            state.leases.flatMap((entry) =>
              entry.kind === "simulator" && entry.deviceId ? [entry.deviceId.toUpperCase()] : [],
            ),
          );
          if (
            state.queue
              .slice(0, index)
              .some(
                (entry) =>
                  entry.simulator &&
                  (sameQueue(entry.simulator, ticket.simulator!) ||
                    !entry.simulator.targetDeviceId ||
                    !leased.has(entry.simulator.targetDeviceId)),
              )
          )
            return blocked("simulator_capacity");
          if (
            options.deviceId &&
            state.leases.some(
              (entry) =>
                entry.kind === "simulator" &&
                entry.deviceId?.toUpperCase() === options.deviceId!.toUpperCase(),
            )
          )
            return blocked("simulator_capacity");
        }
        if (!options.ticketId && state.queue.some((entry) => entry.kind === "simulator"))
          return blocked("simulator_capacity");
        const external = await options.externalActive();
        if (!Number.isSafeInteger(external) || external < 0)
          throw new Error("Simulator inventory unavailable");
        if (
          external + state.leases.filter((entry) => entry.kind === "simulator").length >=
          state.policy.simulatorSlots
        )
          return blocked("simulator_capacity");
        const at = Date.now();
        // A boot's CPU burst outruns the one-minute load average; two at once
        // drove this Mac to load 340 (VUH-1988).
        if (state.leases.some((entry) => entry.kind === "simulator" && at - entry.createdAtMs < bootSettleMs))
          return blocked("pressure");
        const next: SimulatorReservation = {
          id: randomUUID(),
          token: randomUUID(),
          kind: "simulator",
          phase: "reserved",
          ...(options.deviceId ? { deviceId: options.deviceId } : {}),
          ...(options.deviceType ? { deviceType: options.deviceType } : {}),
          ...(options.runtime ? { runtime: options.runtime } : {}),
          seatId: options.seatId,
          occupantId: options.occupantId,
          ...(options.holderId ? { holderId: options.holderId } : {}),
          ...(options.fleet ? { fleet: options.fleet } : {}),
          ...(options.pane ? { pane: options.pane } : {}),
          ...(options.binding ? { binding: structuredClone(options.binding) } : {}),
          ...(options.ownerProcesses ? { ownerProcesses: structuredClone(options.ownerProcesses) } : {}),
          createdAtMs: at,
          lastUsedAtMs: at,
        };
        state.leases.push(next);
        if (options.ticketId) state.queue = state.queue.filter((entry) => entry.id !== options.ticketId);
        return structuredClone(next);
      });
      if (lease) {
        rootHookHint(lease);
        return { admitted: true as const, lease };
      }
      if (!refusal) throw new Error("Simulator admission unavailable");
      return { admitted: false as const, reason: refusal.reason, snapshot: await project(refusal.state) };
    },
    async simulatorHolderHasHeavyWork(owner) {
      if (!owner.holderId || !owner.ownerProcesses?.length) return false;
      const states = await Promise.all([store.read(), lightStore.read(), serverStore.read()]);
      const candidates = states
        .flatMap((state) => [
          ...state.queue
            .filter((entry) => entry.kind === "heavy")
            .map((entry) => ({ ...entry, process: entry.owner })),
          ...state.leases.flatMap((entry) =>
            entry.kind === "heavy" ? [{ ...entry, process: entry.claimOwner }] : [],
          ),
        ])
        // CLI permits may name the pane while simulator admission canonicalizes
        // it to a terminal ID. Labels are not authority; the exact holder and
        // freshly rechecked native process ancestry below establish ownership.
        .filter((entry) => entry.holderId === owner.holderId);
      for (const entry of candidates) {
        if (
          "state" in entry &&
          entry.state === "running" &&
          (!entry.runner || (await probeProcess(entry.runner)) !== "live")
        )
          continue;
        // Walk only this request's ancestry. A copied holder label, another
        // session in the pane or a reused PID cannot keep a simulator alive.
        const chain: ProcessIdentity[] = [];
        let nativeAncestor = false;
        let pid = entry.process.pid;
        for (let depth = 0; pid > 1 && depth < 64; depth++) {
          // The native observer cannot read another user's process (a shell
          // under Terminal's root-owned `login`); that ends the walk at the uid
          // boundary like a readable foreign uid, instead of failing the proof
          // (#389). An unreadable start leaves an empty chain, which grants nothing.
          // allow-swallowed-rejection -- an unreadable ancestor is a boundary, not evidence.
          const current = await processIdentity(pid).catch(() => undefined);
          if (!current || current.uid !== entry.process.uid || chain.some((row) => row.pid === pid)) break;
          if (depth === 0 && current.startTime !== entry.process.startTime) break;
          chain.push(current);
          if (
            owner.ownerProcesses.some((proof) => proof.pid === pid && proof.startTime === current.startTime)
          ) {
            nativeAncestor = true;
            break;
          }
          pid = current.ppid;
        }
        // Codex tool commands descend from its original detached app-server,
        // not its foreground TUI. Only the host's native registration can join
        // that observed ancestry to the same seat/occupant/binding.
        if (!nativeAncestor && !(chain.length && (await options.nativeSimulatorOwner?.(owner, chain))))
          continue;
        // Recheck every birth and edge after either proof, including the
        // foreground native holder. Unknown or changing evidence grants no time.
        const fresh = await Promise.all(chain.map((row) => processIdentity(row.pid)));
        if (
          fresh.every(
            (row, index) => row?.startTime === chain[index]!.startTime && row?.ppid === chain[index]!.ppid,
          ) &&
          (await Promise.all(owner.ownerProcesses.map(probeProcess))).every((state) => state === "live")
        )
          return true;
      }
      return false;
    },
    async simulatorReservations() {
      return structuredClone(
        (await store.read()).leases.filter(
          (lease): lease is SimulatorReservation => lease.kind === "simulator",
        ),
      );
    },
    async updateSimulator(id: string, token: string, update: SimulatorUpdate) {
      const allowed = new Set(["phase", "deviceId", "deviceName", "deviceType", "runtime", "lastUsedAtMs"]);
      for (const [key, value] of Object.entries(update))
        if (
          !allowed.has(key) ||
          (typeof value === "string" && (value.length > 512 || value.includes("\0"))) ||
          (key === "lastUsedAtMs" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0))
        )
          throw new Error("Invalid simulator journal update");
      const updated = await store.transaction((state) => {
        const lease = state.leases.find(
          (entry): entry is SimulatorReservation =>
            entry.kind === "simulator" && entry.id === id && entry.token === token,
        );
        if (!lease) throw new Error("Simulator reservation changed");
        Object.assign(lease, update);
        return structuredClone(lease);
      });
      rootHookHint(updated);
      return updated;
    },
    async releaseSimulator(id: string, token: string) {
      const removed = await store.transaction((state) => {
        const prior = state.leases.find(
          (lease): lease is SimulatorReservation =>
            lease.kind === "simulator" && lease.id === id && lease.token === token,
        );
        state.leases = state.leases.filter(
          (lease) => !(lease.kind === "simulator" && lease.id === id && lease.token === token),
        );
        return prior;
      });
      if (removed)
        await store.transaction((state) => {
          // Serialize hint cleanup with grants. One device ending does not retire
          // a shared holder/pane hint while another reservation remains.
          const remaining = state.leases.find(
            (lease): lease is SimulatorReservation =>
              lease.kind === "simulator" &&
              lease.holderId === removed.holderId &&
              lease.pane === removed.pane &&
              lease.binding?.socketPath === removed.binding?.socketPath,
          );
          rootHookHint(remaining ?? removed, !remaining);
        });
    },
    async recordSimulatorSettled(receipt: SimulatorSettledReceipt) {
      await recordReaped([receipt], directory, "simulator-settled.jsonl");
    },
    async close() {
      shutdown.abort();
      await Promise.allSettled(active);
      for (const journal of [store, lightStore, serverStore]) journal.close();
    },
  };
}
