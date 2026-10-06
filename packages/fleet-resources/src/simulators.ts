import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FleetResourceGovernor, SimulatorReservation } from "./model.ts";
import { probeProcess } from "./process.ts";
import { createSimctlAdapter, type SimulatorAdapter, type SimulatorDevice } from "./simctl.ts";

export interface SimulatorOwner {
  readonly seatId: string;
  readonly occupantId: string;
  readonly fleet?: string;
  readonly pane: string;
  readonly processes: readonly { readonly pid: number; readonly startTime: string }[];
  readonly binding?: { readonly socketPath: string; readonly session?: string };
}
export interface SimulatorAcquireRequest {
  readonly seatId: string;
  readonly occupantId: string;
  readonly fleet?: string;
  readonly deviceType: string;
  readonly runtime: string;
  readonly signal?: AbortSignal;
  readonly authorize?: () => Promise<boolean>;
}
export interface SimulatorRequestOptions {
  readonly signal?: AbortSignal;
  readonly authorize?: () => Promise<boolean>;
}
export interface SimulatorLeaseView {
  readonly id: string;
  readonly seatId: string;
  readonly occupantId: string;
  readonly fleet?: string;
  readonly phase: string;
  readonly createdAtMs: number;
  readonly lastUsedAtMs: number;
  readonly deviceId?: string;
  readonly deviceName?: string;
  readonly deviceType?: string;
  readonly runtime?: string;
}
export type SimulatorResult =
  | { readonly outcome: "acquired" | "held"; readonly lease: SimulatorLeaseView }
  | { readonly outcome: "released" }
  | {
      readonly outcome: "rejected";
      readonly reason:
        | "owner_unavailable"
        | "stale_owner"
        | "inventory_unavailable"
        | "capacity"
        | "lease_unavailable";
    };

type SeatIdentity = Pick<SimulatorOwner, "seatId" | "occupantId" | "fleet">;
const sameSeat = (a: SeatIdentity, b: SeatIdentity) =>
  a.seatId === b.seatId && a.occupantId === b.occupantId && (a.fleet ?? "default") === (b.fleet ?? "default");
const active = (device: SimulatorDevice) => ["Booted", "Booting", "Shutting Down"].includes(device.state);
const known = (device: SimulatorDevice) =>
  ["Shutdown", "Booted", "Booting", "Shutting Down"].includes(device.state);
const view = (lease: SimulatorReservation): SimulatorLeaseView => {
  const {
    id,
    seatId,
    occupantId,
    fleet,
    phase,
    createdAtMs,
    lastUsedAtMs,
    deviceId,
    deviceName,
    deviceType,
    runtime,
  } = lease;
  return {
    id,
    seatId,
    occupantId,
    ...(fleet === undefined ? {} : { fleet }),
    phase,
    createdAtMs,
    lastUsedAtMs,
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(deviceName === undefined ? {} : { deviceName }),
    ...(deviceType === undefined ? {} : { deviceType }),
    ...(runtime === undefined ? {} : { runtime }),
  };
};

/** Machine-owned leases; stopping this observer never changes a simulator's lifetime. */
export function createSimulatorManager(input: {
  governor: FleetResourceGovernor;
  adapter?: SimulatorAdapter;
  observeSeat?: (
    identity: SeatIdentity,
  ) => Promise<
    { identity: SimulatorOwner; processes?: SimulatorOwner["processes"]; status: string } | undefined
  >;
  onChange?: () => void;
  clock?: () => number;
  processProbe?: typeof probeProcess;
}) {
  const adapter = input.adapter ?? createSimctlAdapter();
  const now = input.clock ?? Date.now;
  const probe = input.processProbe ?? probeProcess;
  const authorized = async (authority?: SimulatorRequestOptions): Promise<boolean> => {
    if (authority?.signal?.aborted) return false;
    try {
      return (
        (authority?.authorize === undefined || (await authority.authorize())) &&
        authority?.signal?.aborted !== true
      );
    } catch {
      return false;
    }
  };
  const denied = (): SimulatorResult => ({ outcome: "rejected", reason: "owner_unavailable" });
  let timer: ReturnType<typeof setInterval> | undefined;
  let operations: Promise<unknown> = Promise.resolve();
  const acquisitions = new Map<string, Promise<SimulatorResult>>();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operations.then(operation, operation);
    operations = result.catch(() => undefined);
    return result;
  };
  const changed = () => {
    try {
      input.onChange?.();
    } catch {
      /* Observation cannot undo admission. */
    }
  };
  const update = async (
    lease: SimulatorReservation,
    patch: Parameters<FleetResourceGovernor["updateSimulator"]>[2],
  ) => {
    const next = await input.governor.updateSimulator(lease.id, lease.token, patch);
    changed();
    return next;
  };
  const forget = async (lease: SimulatorReservation): Promise<SimulatorResult> => {
    await input.governor.releaseSimulator(lease.id, lease.token);
    changed();
    return { outcome: "released" };
  };
  const inventory = async () => {
    const devices = await adapter.inventory();
    if (devices.some((device) => !known(device))) throw new Error("Simulator inventory has unknown states");
    return devices;
  };
  const reservations = () => input.governor.simulatorReservations();
  const externalActive = async () => {
    const [devices, leases] = await Promise.all([inventory(), reservations()]);
    const owned = new Set(leases.flatMap((lease) => (lease.deviceId ? [lease.deviceId.toUpperCase()] : [])));
    return devices.filter((device) => active(device) && !owned.has(device.udid.toUpperCase())).length;
  };
  const prove = async (identity: SeatIdentity): Promise<SimulatorOwner | undefined> => {
    const observed = await input.observeSeat?.(identity);
    if (!observed || !sameSeat(observed.identity, identity) || observed.identity.processes.length === 0)
      return undefined;
    if ((await Promise.all(observed.identity.processes.map(probe))).some((state) => state !== "live"))
      return undefined;
    return observed.identity;
  };
  const matchesOwner = (lease: SimulatorReservation, owner: SimulatorOwner) =>
    sameSeat(lease, owner) &&
    lease.pane === owner.pane &&
    isDeepStrictEqual(lease.ownerProcesses, owner.processes) &&
    isDeepStrictEqual(lease.binding, owner.binding);
  const deviceFor = (lease: SimulatorReservation, devices: readonly SimulatorDevice[]) => {
    const found = devices.find((device) => device.udid.toUpperCase() === lease.deviceId?.toUpperCase());
    if (
      found &&
      (found.runtime !== lease.runtime ||
        (found.deviceType !== undefined && found.deviceType !== lease.deviceType))
    )
      throw new Error("Recorded simulator characteristics changed");
    return found;
  };
  const held = (lease: SimulatorReservation): SimulatorResult => ({ outcome: "held", lease: view(lease) });
  // Each effect is durably marked first and is attempted once. Missing replies
  // are reconciled by UUID inventory; a name never establishes device ownership.
  const removeStopped = async (
    lease: SimulatorReservation,
    authority?: SimulatorRequestOptions,
  ): Promise<SimulatorResult> => {
    if (!lease.deviceId) return held(lease);
    if (!(await authorized(authority))) return held(lease);
    const previousPhase = lease.phase;
    lease = await update(lease, { phase: "delete-submitted" });
    if (!(await authorized(authority))) return held(await update(lease, { phase: previousPhase }));
    try {
      await adapter.delete(lease.deviceId!);
    } catch {
      lease = await update(lease, { phase: "delete-uncertain" });
    }
    const devices = await inventory();
    return deviceFor(lease, devices) === undefined && (await authorized(authority))
      ? forget(lease)
      : held(lease);
  };
  const reconcile = async (
    lease: SimulatorReservation,
    cleanup = false,
    authority?: SimulatorRequestOptions,
  ): Promise<SimulatorResult> => {
    if (!lease.deviceId) return held(lease);
    const devices = await inventory();
    const device = deviceFor(lease, devices);
    if (!(await authorized(authority))) return held(lease);
    if (!device) return forget(lease);
    if (["delete-submitted", "delete-uncertain"].includes(lease.phase)) return held(lease);
    if (["shutdown-submitted", "shutdown-uncertain"].includes(lease.phase)) {
      return device.state === "Shutdown" ? removeStopped(lease, authority) : held(lease);
    }
    if (["boot-submitted", "boot-uncertain"].includes(lease.phase)) {
      if (device.state === "Booted") lease = await update(lease, { phase: "booted" });
      else return held(lease); // A shutdown observation alone cannot settle a lost boot request.
    }
    if (!cleanup) return held(lease);
    if (device.state === "Shutdown" && lease.phase === "created") return removeStopped(lease, authority);
    if (device.state !== "Booted" || lease.phase !== "booted") return held(lease);
    lease = await update(lease, { phase: "shutdown-submitted" });
    if (!(await authorized(authority))) return held(await update(lease, { phase: "booted" }));
    try {
      await adapter.shutdown(lease.deviceId!);
    } catch {
      lease = await update(lease, { phase: "shutdown-uncertain" });
    }
    return reconcile(lease, false, authority);
  };
  const find = async (id: string) => (await reservations()).find((lease) => lease.id === id);

  const acquire = async (request: SimulatorAcquireRequest): Promise<SimulatorResult> => {
    const owner = await prove(request);
    if (!(await authorized(request))) return denied();
    if (!owner) return { outcome: "rejected", reason: "owner_unavailable" };
    const existing = (await reservations()).find((lease) => sameSeat(lease, owner));
    if (!(await authorized(request))) return denied();
    if (existing)
      return matchesOwner(existing, owner) ? held(existing) : { outcome: "rejected", reason: "stale_owner" };
    let lease: SimulatorReservation;
    let authorityLost = false;
    try {
      lease = await input.governor.acquireSimulator({
        seatId: owner.seatId,
        occupantId: owner.occupantId,
        ...(owner.fleet === undefined ? {} : { fleet: owner.fleet }),
        pane: owner.pane,
        ownerProcesses: [...owner.processes],
        ...(owner.binding === undefined ? {} : { binding: owner.binding }),
        externalActive: async () => {
          const count = await externalActive();
          if (!(await authorized(request))) {
            authorityLost = true;
            throw new Error("Simulator authorization changed");
          }
          return count;
        },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch {
      return authorityLost ? denied() : { outcome: "rejected", reason: "capacity" };
    }
    return serial(async () => {
      try {
        const current = await prove(owner);
        if (!current || !matchesOwner(lease, current)) {
          await forget(lease);
          return { outcome: "rejected", reason: "stale_owner" };
        }
        const { policy } = await input.governor.snapshot();
        if ((await externalActive()) + (await reservations()).length > policy.simulatorSlots) {
          await forget(lease);
          return { outcome: "rejected", reason: "capacity" };
        }
        if (!(await authorized(request))) {
          await forget(lease);
          return denied();
        }
        const deviceName = `Clankie-${randomUUID()}`;
        lease = await update(lease, {
          phase: "create-submitted",
          deviceName,
          deviceType: request.deviceType,
          runtime: request.runtime,
        });
        if (!(await authorized(request))) {
          await forget(lease);
          return denied();
        }
        let deviceId: string;
        try {
          deviceId = await adapter.create(deviceName, request.deviceType, request.runtime);
        } catch {
          lease = await update(lease, { phase: "create-uncertain" });
          return held(lease);
        }
        lease = await update(lease, { phase: "created", deviceId });
        const devices = await inventory();
        const created = deviceFor(lease, devices);
        if (!created || created.state !== "Shutdown" || !created.available) return held(lease);
        const live = await prove(owner);
        const occupancy = (await externalActive()) + (await reservations()).length;
        if (!(await authorized(request))) return held(lease);
        if (!live || !matchesOwner(lease, live) || occupancy > policy.simulatorSlots)
          return reconcile(lease, true);
        lease = await update(lease, { phase: "boot-submitted", lastUsedAtMs: now() });
        if (!(await authorized(request))) return held(await update(lease, { phase: "created" }));
        try {
          await adapter.boot(deviceId);
        } catch {
          lease = await update(lease, { phase: "boot-uncertain" });
          return held(lease);
        }
        const booted = deviceFor(lease, await inventory());
        if (booted?.state !== "Booted") return held(lease);
        lease = await update(lease, { phase: "booted" });
        return { outcome: "acquired", lease: view(lease) };
      } catch {
        return held(lease);
      }
    });
  };
  const manager = {
    acquire(request: SimulatorAcquireRequest): Promise<SimulatorResult> {
      const key = JSON.stringify([request.fleet ?? "default", request.seatId, request.occupantId]);
      const pending = acquisitions.get(key);
      if (pending) return pending.then(async (result) => ((await authorized(request)) ? result : denied()));
      const result = acquire(request).finally(() => acquisitions.delete(key));
      acquisitions.set(key, result);
      return result;
    },
    async touch(
      id: string,
      owner: SimulatorOwner,
      authority?: SimulatorRequestOptions,
    ): Promise<SimulatorResult> {
      return serial(async () => {
        const lease = await find(id);
        if (!lease) return { outcome: "rejected", reason: "lease_unavailable" };
        const current = await prove(owner);
        if (!(await authorized(authority))) return denied();
        if (!current || !matchesOwner(lease, owner) || !matchesOwner(lease, current))
          return { outcome: "rejected", reason: "stale_owner" };
        return held(await update(lease, { lastUsedAtMs: now() }));
      });
    },
    async release(
      id: string,
      owner: SimulatorOwner,
      authority?: SimulatorRequestOptions,
    ): Promise<SimulatorResult> {
      return serial(async () => {
        const lease = await find(id);
        if (!lease) return { outcome: "rejected", reason: "lease_unavailable" };
        const current = await prove(owner);
        if (!(await authorized(authority))) return denied();
        if (!current || !matchesOwner(lease, owner) || !matchesOwner(lease, current))
          return { outcome: "rejected", reason: "stale_owner" };
        try {
          return await reconcile(lease, true, authority);
        } catch {
          return held(lease);
        }
      });
    },
    async observeSeatState(identity: SimulatorOwner, _status: string): Promise<void> {
      // Harness turns do not renew simulator use. Only touch/acquire is activity.
      if ((await reservations()).some((lease) => matchesOwner(lease, identity))) await manager.tick();
    },
    async observeSeatExited(identity: SimulatorOwner): Promise<void> {
      await serial(async () => {
        for (const lease of await reservations()) {
          if (!matchesOwner(lease, identity) || identity.processes.length === 0) continue;
          if ((await Promise.all(identity.processes.map(probe))).some((state) => state !== "exited"))
            continue;
          try {
            await reconcile(lease, true);
          } catch {
            /* Unknown native state retains capacity. */
          }
        }
      });
    },
    async snapshot(): Promise<{
      leases: SimulatorLeaseView[];
      inventory: "available" | "unavailable";
      externalActive: number | null;
    }> {
      const leases = (await reservations()).map(view);
      try {
        return { leases, inventory: "available", externalActive: await externalActive() };
      } catch {
        return { leases, inventory: "unavailable", externalActive: null };
      }
    },
    async tick(): Promise<void> {
      await serial(async () => {
        const { policy } = await input.governor.snapshot();
        for (const lease of await reservations()) {
          try {
            const processes = lease.ownerProcesses ?? [];
            const exited =
              processes.length > 0 &&
              (await Promise.all(processes.map(probe))).every((state) => state === "exited");
            await reconcile(lease, exited || now() - lease.lastUsedAtMs >= policy.simulatorIdleMs);
          } catch {
            /* Unknown inventory or command outcome never frees a slot. */
          }
        }
      });
    },
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        void manager.tick().catch(() => undefined);
      }, 5_000);
      timer.unref();
      void manager.tick().catch(() => undefined);
    },
    close(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return manager;
}
