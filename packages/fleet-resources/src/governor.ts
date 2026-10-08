import { randomUUID } from "node:crypto";
import { constants, userInfo } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  FleetResourcePolicySchema,
  type FleetResourceGovernor,
  type FleetResourcePolicy,
  type HeavyLease,
  type ProcessIdentity,
  type ResourcePressureInput,
  type ResourceSnapshot,
  type ResourceState,
  type ResourceWaitOptions,
  type SimulatorReservation,
  type SimulatorUpdate,
} from "./model.ts";
import { processIdentity, observeProcesses, resourceNativeHelperPath, resourcePython } from "./process.ts";
import { resourceCapacity, ResourcePressureSampler } from "./pressure.ts";
import { ResourceStore } from "./store.ts";

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
/** One canonical machine registry; runtime/worktree environment cannot increase capacity. */
export function createResourceGovernor(
  options: { directory?: string; probe?: () => Promise<ResourcePressureInput> } = {},
): FleetResourceGovernor {
  const directory = options.directory ?? join(userInfo().homedir, ".clankie/fleet-resources");
  const store = new ResourceStore(directory);
  const pressure = new ResourcePressureSampler(options.probe);
  const shutdown = new AbortController();
  const active = new Set<Promise<unknown>>();
  async function reconcile(state: ResourceState): Promise<void> {
    if (!state.leases.some((lease) => lease.kind === "heavy") && state.queue.length === 0) return;
    // This state and its exact recorded PIDs belong to the held OS lock. Avoid
    // broad census authority, cross-transaction caches and one fork per ticket.
    const observations = await observeProcesses([
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
    ]);
    const observe = (proof: ProcessIdentity) => {
      const observation = observations.get(proof.pid);
      if (!observation || observation.status === "unknown") throw new Error("Process identity unavailable");
      return observation.status === "live" ? observation.identity : undefined;
    };
    const queue = [];
    for (const entry of state.queue) {
      try {
        if (matches(observe(entry.owner), entry.owner)) queue.push(entry);
      } catch {
        queue.push(entry);
      }
    }
    state.queue = queue;
    const retained: ResourceState["leases"] = [];
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
          continue;
        }
        if (!lease.runner) {
          retained.push(lease);
          continue;
        }
        const root = observe(lease.runner);
        if (matches(root, lease.runner)) {
          retained.push(lease);
        } else if (root && root.pgid === root.pid) {
          // The original process group ended before this reused PID became a
          // new group leader. It is not authority to signal that new process.
        } else if (groupAlive(lease.runner.pgid)) {
          // A dead runner can leave living descendants in its process group.
          // Kernel group existence prevents early reclamation without a census.
          retained.push(lease);
        }
      } catch {
        retained.push(lease);
      }
    }
    state.leases = retained;
  }
  async function project(state: ResourceState): Promise<ResourceSnapshot> {
    return {
      schemaVersion: 1,
      policy: state.policy,
      capacity: {
        heavySlots: resourceCapacity(state.policy),
        simulatorSlots: state.policy.simulatorSlots,
        used: state.leases.length,
      },
      pressure: await pressure.sample(state.policy),
      leases: state.leases.map((lease) => ({
        id: lease.id,
        kind: lease.kind,
        state: lease.kind === "heavy" ? lease.state : lease.phase,
        ...(lease.seatId ? { seatId: lease.seatId } : {}),
        ...(lease.kind === "heavy"
          ? { executable: lease.executable }
          : lease.deviceId
            ? { deviceId: lease.deviceId }
            : {}),
        createdAtMs: lease.createdAtMs,
        lastUsedAtMs: lease.lastUsedAtMs,
        ...(lease.kind === "heavy" && lease.runner ? { pid: lease.runner.pid } : {}),
      })),
      queue: state.queue.map(({ id, kind, seatId, executable, queuedAtMs, owner }) => ({
        id,
        kind,
        ...(seatId ? { seatId } : {}),
        ...(executable ? { executable } : {}),
        queuedAtMs,
        pid: owner.pid,
      })),
    };
  }
  async function snapshot() {
    let state = await store.read();
    if (state.leases.some((lease) => lease.kind === "heavy") || state.queue.length)
      state = await store.transaction(async (current) => {
        await reconcile(current);
        return structuredClone(current);
      });
    return project(state);
  }
  async function acquire(
    options: ResourceWaitOptions & { seatId?: string; executable: string },
  ): Promise<HeavyLease> {
    const owner = await processIdentity();
    if (!owner) throw new Error("Fleet resource process identity unavailable");
    const signal = options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal;
    if (signal.aborted) throw abort();
    if (options.seatId && (options.seatId.length > 256 || options.seatId.includes("\0")))
      throw new Error("Invalid fleet seat identity");
    const id = randomUUID(),
      token = randomUUID();
    await store.transaction(
      async (state) => {
        await reconcile(state);
        if (state.queue.length >= 512) throw new Error("Fleet resource queue is full");
        state.queue.push({
          id,
          token,
          kind: "heavy",
          owner,
          queuedAtMs: Date.now(),
          ...(options.seatId ? { seatId: options.seatId } : {}),
          executable: options.executable,
        });
      },
      { signal },
    );
    let admitted = false;
    try {
      for (;;) {
        if (signal.aborted) throw abort();
        let advisory: ResourceState | undefined;
        const lease = await store.transaction(
          async (state) => {
            await reconcile(state);
            const blocked = () => {
              if (options.onWait) advisory = structuredClone(state);
              return undefined;
            };
            if (state.queue[0]?.id !== id || state.leases.length >= resourceCapacity(state.policy))
              return blocked();
            if (!(await pressure.sample(state.policy)).healthy) return blocked();
            if (signal.aborted) throw abort();
            const at = Date.now();
            const next: HeavyLease = {
              id,
              token,
              kind: "heavy",
              state: "starting",
              claimOwner: owner,
              executable: options.executable,
              ...(options.seatId ? { seatId: options.seatId } : {}),
              createdAtMs: at,
              lastUsedAtMs: at,
            };
            state.queue.shift();
            state.leases.push(next);
            return structuredClone(next);
          },
          { signal },
        );
        if (lease) {
          admitted = true;
          return lease;
        }
        // This is advisory status from the same attempt, projected after the
        // transaction commits; publishing a wait must not acquire another lock.
        if (advisory) options.onWait?.(await project(advisory));
        await wait(500, signal);
      }
    } finally {
      if (!admitted)
        await store.transaction((state) => {
          state.queue = state.queue.filter((entry) => entry.id !== id || entry.token !== token);
        });
    }
  }
  async function inherited(): Promise<HeavyLease | undefined> {
    let ref: { id?: string; token?: string };
    try {
      ref = JSON.parse(process.env.CLANKIE_RESOURCE_LEASE ?? "null") ?? {};
    } catch {
      return undefined;
    }
    const lease = (await store.read()).leases.find(
      (entry): entry is HeavyLease =>
        entry.kind === "heavy" && entry.id === ref.id && entry.token === ref.token,
    );
    if (!lease?.runner || lease.state !== "running") return undefined;
    const mine = await processIdentity();
    if (!mine || mine.pgid !== lease.runner.pgid || mine.uid !== lease.runner.uid) return undefined;
    const root = await processIdentity(lease.runner.pid);
    if (root && !matches(root, lease.runner)) return undefined;
    return lease;
  }
  async function runHeavy(
    command: string,
    args: readonly string[],
    options: ResourceWaitOptions & { seatId?: string } = {},
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
    let child: ReturnType<typeof spawn> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const parentLease = await inherited();
      if (signal.aborted) throw abort();
      if (parentLease) {
        child = spawn(command, [...args], { stdio: "inherit" });
        const done = new Promise<number>((resolve, reject) => {
          child!.once("error", () => reject(new Error("Heavy command could not start")));
          child!.once("exit", (code, sig) => resolve(code ?? (sig ? 128 + constants.signals[sig] : 1)));
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
      lease = await acquire({
        ...options,
        signal,
        executable: basename(command).slice(0, 128),
      });
      if (signal.aborted) throw abort();
      child = spawn(
        resourcePython,
        ["-I", resourceNativeHelperPath(), "run", directory, lease.id, lease.token],
        { detached: true, stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"] },
      );
      const done = new Promise<number>((resolve, reject) => {
        child!.once("error", () => reject(new Error("Fleet heavy runner requires Python 3")));
        child!.once("exit", (code, sig) => resolve(code ?? (sig ? 128 + constants.signals[sig] : 1)));
      });
      void done.catch(() => undefined);
      const input = child.stdio[3] as Writable;
      const replies = createInterface({ input: child.stdio[4] as Readable });
      const first = replies[Symbol.asyncIterator]().next();
      input.write(`${JSON.stringify({ command, args })}\n`);
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
        if (matches(await processIdentity(runner.pid), runner)) process.kill(-runner.pgid, sig);
      };
      const cancel = () => {
        void sendSignal(interrupted.signal.reason === "SIGINT" ? "SIGINT" : "SIGTERM").catch(() => undefined);
        killTimer = setTimeout(() => {
          void sendSignal("SIGKILL").catch(() => undefined);
        }, 2_000);
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) {
        input.end();
        cancel();
      } else input.write("go\n");
      try {
        return await done;
      } finally {
        signal.removeEventListener("abort", cancel);
        input.end();
      }
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError"))
        return interrupted.signal.reason === "SIGTERM" ? 143 : 130;
      throw error;
    } finally {
      if (killTimer) clearTimeout(killTimer);
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      if (lease)
        await store.transaction(async (state) => {
          await reconcile(state);
        });
    }
  }
  return {
    async configure(policy: FleetResourcePolicy) {
      const parsed = FleetResourcePolicySchema.parse(policy);
      const state = await store.transaction((current) => {
        current.policy = parsed;
        return structuredClone(current);
      });
      return project(state);
    },
    snapshot,
    async admitBuilder() {
      const state = await store.read(),
        sample = await pressure.sample(state.policy);
      return {
        allowed: sample.healthy,
        ...(!sample.healthy
          ? {
              reason:
                sample.reason === "probe-unavailable"
                  ? ("probe-unavailable" as const)
                  : ("pressure" as const),
            }
          : {}),
        pressure: sample,
      };
    },
    runHeavy(command, args, options) {
      const job = runHeavy(command, args, options);
      active.add(job);
      void job.finally(() => active.delete(job)).catch(() => undefined);
      return job;
    },
    async tryAcquireSimulator(options) {
      if (
        !options.seatId ||
        !options.occupantId ||
        options.occupantId.length > 512 ||
        (options.ownerProcesses?.length ?? 0) > 32
      )
        throw new Error("Simulator requires an exact named seat owner");
      if (shutdown.signal.aborted) throw abort();
      let refusal: { reason: SimulatorBlock; state: ResourceState } | undefined;
      const lease = await store.transaction(async (state) => {
        await reconcile(state);
        if (state.policy.simulatorSlots === 0) throw new SimulatorsDisabledError();
        const blocked = (reason: SimulatorBlock) => {
          refusal = { reason, state: structuredClone(state) };
          return undefined;
        };
        // Simulators never queue: a caller that is told what holds the slots
        // polls again, so no ticket outlives its request (VUH-1816).
        const external = await options.externalActive();
        if (!Number.isSafeInteger(external) || external < 0)
          throw new Error("Simulator inventory unavailable");
        if (
          external + state.leases.filter((entry) => entry.kind === "simulator").length >=
          state.policy.simulatorSlots
        )
          return blocked("simulator_capacity");
        if (state.leases.length >= resourceCapacity(state.policy)) return blocked("shared_capacity");
        if (!(await pressure.sample(state.policy)).healthy) return blocked("pressure");
        const at = Date.now();
        const next: SimulatorReservation = {
          id: randomUUID(),
          token: randomUUID(),
          kind: "simulator",
          phase: "reserved",
          seatId: options.seatId,
          occupantId: options.occupantId,
          ...(options.fleet ? { fleet: options.fleet } : {}),
          ...(options.pane ? { pane: options.pane } : {}),
          ...(options.binding ? { binding: structuredClone(options.binding) } : {}),
          ...(options.ownerProcesses ? { ownerProcesses: structuredClone(options.ownerProcesses) } : {}),
          createdAtMs: at,
          lastUsedAtMs: at,
        };
        state.leases.push(next);
        return structuredClone(next);
      });
      if (lease) return { admitted: true as const, lease };
      if (!refusal) throw new Error("Simulator admission unavailable");
      return { admitted: false as const, reason: refusal.reason, snapshot: await project(refusal.state) };
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
      return store.transaction((state) => {
        const lease = state.leases.find(
          (entry): entry is SimulatorReservation =>
            entry.kind === "simulator" && entry.id === id && entry.token === token,
        );
        if (!lease) throw new Error("Simulator reservation changed");
        Object.assign(lease, update);
        return structuredClone(lease);
      });
    },
    async releaseSimulator(id: string, token: string) {
      await store.transaction((state) => {
        state.leases = state.leases.filter(
          (lease) => !(lease.kind === "simulator" && lease.id === id && lease.token === token),
        );
      });
    },
    async close() {
      shutdown.abort();
      await Promise.allSettled(active);
    },
  };
}
