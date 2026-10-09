import { observeSimulatorUsage, simulatorUsageFor, type SimulatorUsage } from "./simulator-usage.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SimulatorsDisabledError } from "./governor.ts";
import type { FleetResourceGovernor, ResourceSnapshot, SimulatorReservation } from "./model.ts";
import { probeProcess } from "./process.ts";
import {
  createSimctlAdapter,
  type SimulatorAdapter,
  type SimulatorCatalog,
  type SimulatorDevice,
} from "./simctl.ts";

export interface SimulatorOwner {
  readonly seatId: string;
  readonly occupantId: string;
  /** Distinguishes native children; grants no seat or process authority. */
  readonly holderId?: string;
  readonly fleet?: string;
  readonly pane: string;
  readonly processes: readonly { readonly pid: number; readonly startTime: string }[];
  readonly binding?: { readonly socketPath: string; readonly session?: string };
}
export interface SimulatorAcquireRequest {
  readonly seatId: string;
  readonly occupantId: string;
  /** Distinguishes native children; grants no seat or process authority. */
  readonly holderId?: string;
  readonly fleet?: string;
  /** Required unless `deviceId` names the device to lease. */
  readonly deviceType?: string;
  readonly runtime?: string;
  /** Lease this existing device, such as one the seat booted by hand. */
  readonly deviceId?: string;
  /** Never substitute a close model. */
  readonly exact?: boolean;
  /** One server-side wait on the persisted ticket, rather than repeated client acquire calls. */
  readonly waitMs?: number;
  readonly ticketId?: string;
  readonly waitSignal?: AbortSignal;
  /**
   * Current owner authority. It is checked before every native effect; the
   * caller's connection is not authority, so a disconnect never strands work.
   */
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
  /** Distinguishes native children; grants no seat or process authority. */
  readonly holderId?: string;
  readonly fleet?: string;
  readonly phase: string;
  readonly createdAtMs: number;
  readonly lastUsedAtMs: number;
  readonly deviceId?: string;
  readonly deviceName?: string;
  readonly deviceType?: string;
  readonly runtime?: string;
  readonly usage?: SimulatorUsage;
  readonly origin?: "created" | "existing";
  readonly requestedDeviceType?: string;
}
export interface SimulatorHolder {
  readonly pid: number;
  readonly executable: string;
  readonly seatId?: string;
  readonly pane?: string;
}
export interface ExternalSimulatorView {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
  readonly runtime: string;
  readonly deviceType?: string;
  readonly holders: readonly SimulatorHolder[];
  readonly usage?: SimulatorUsage;
}
export interface SimulatorBlockers {
  readonly simulatorSlots: number;
  readonly heavySlots?: number;
  /** Legacy server output. */
  readonly sharedSlots?: number;
  readonly leases: readonly {
    id: string;
    seatId: string;
    holderId?: string;
    phase: string;
    deviceName?: string;
    deviceId?: string;
  }[];
  readonly external: readonly ExternalSimulatorView[];
  readonly heavy: readonly { seatId?: string; executable?: string; pid?: number }[];
  readonly pressure?: {
    reason?: "load" | "memory" | "probe-unavailable";
    loadRatio: number;
    availableMemoryMb: number;
  };
}
export type SimulatorRejection =
  | "owner_unavailable"
  | "stale_owner"
  | "inventory_unavailable"
  | "capacity"
  | "lease_unavailable"
  | "service_restarting"
  | "authorization_revoked"
  | "simulators_disabled"
  | "device_unavailable"
  | "seat_not_local"
  | "internal_error"
  | "ticket_unavailable";
export type SimulatorResult =
  | {
      readonly outcome: "planned";
      readonly choice: "reuse" | "create";
      readonly simulatorIdleMs: number;
    }
  | {
      readonly outcome: "acquired" | "held" | "booting";
      readonly lease: SimulatorLeaseView;
      readonly retryAfterMs?: number;
    }
  | { readonly outcome: "released" | "cancelled" }
  | {
      readonly outcome: "waiting";
      readonly ticket?: ResourceSnapshot["queue"][number];
      readonly reason: "simulator_capacity" | "shared_capacity" | "pressure";
      readonly blockers: SimulatorBlockers;
      readonly retryAfterMs: number;
      readonly hint: string;
    }
  | {
      readonly outcome: "rejected";
      readonly reason: SimulatorRejection;
      readonly detail?: string;
      readonly alternatives?: readonly { deviceType: string; name: string; udid?: string }[];
    };
export interface SimulatorStatusView {
  leases: SimulatorLeaseView[];
  inventory: "available" | "unavailable";
  externalActive: number | null;
  external?: ExternalSimulatorView[];
  simulatorSlots?: number;
  hint?: string;
}

type SeatIdentity = Pick<SimulatorOwner, "seatId" | "occupantId" | "fleet" | "holderId">;
const sameNativeSeat = (a: SeatIdentity, b: SeatIdentity) =>
  a.seatId === b.seatId && a.occupantId === b.occupantId && (a.fleet ?? "default") === (b.fleet ?? "default");
const sameSeat = (a: SeatIdentity, b: SeatIdentity) => sameNativeSeat(a, b) && a.holderId === b.holderId;
const active = (device: SimulatorDevice) => ["Booted", "Booting", "Shutting Down"].includes(device.state);
const known = (device: SimulatorDevice) =>
  ["Shutdown", "Booted", "Booting", "Shutting Down"].includes(device.state);
/** Informational historical fleet label; a name never establishes ownership. */
const createdName = /^Clankie-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const createdBy = (lease: Pick<SimulatorReservation, "deviceName">) =>
  lease.deviceName === undefined || createdName.test(lease.deviceName);
/** A chip or memory suffix distinguishes otherwise identical screens (iPad Air 11-inch M3 vs M4). */
const family = (deviceType: string) => deviceType.replace(/-(?:M|A)\d+(?:-Pro)?(?:-\d+GB)?$/u, "");
const mobileFamily = (deviceType: string) =>
  /^com\.apple\.CoreSimulator\.SimDeviceType\.(iPhone|iPad)(?:-|$)/u.exec(deviceType)?.[1];
const sameFamily = (left: string, right: string) =>
  family(left) === family(right) ||
  (mobileFamily(left) !== undefined && mobileFamily(left) === mobileFamily(right));
const RETRY_MS = 5_000;
const view = (lease: SimulatorReservation, requestedDeviceType?: string): SimulatorLeaseView => {
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
    ...(lease.holderId === undefined ? {} : { holderId: lease.holderId }),
    ...(fleet === undefined ? {} : { fleet }),
    phase,
    createdAtMs,
    lastUsedAtMs,
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(deviceName === undefined ? {} : { deviceName }),
    ...(deviceType === undefined ? {} : { deviceType }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(deviceName === undefined ? {} : { origin: createdBy(lease) ? "created" : "existing" }),
    ...(requestedDeviceType === undefined || requestedDeviceType === deviceType
      ? {}
      : { requestedDeviceType }),
  };
};
type Plan =
  | { kind: "existing"; device: SimulatorDevice }
  | { kind: "create"; deviceType: string; runtime: string }
  | { kind: "waiting"; detail: string }
  | {
      kind: "refuse";
      detail: string;
      alternatives?: { deviceType: string; name: string; udid?: string }[];
    };
const BOOTING_PHASES = new Set([
  "reserved",
  "create-submitted",
  "created",
  "boot-submitted",
  "boot-uncertain",
]);

/** Machine-owned leases; stopping this observer never changes a simulator's lifetime. */
export function createSimulatorManager(input: {
  governor: FleetResourceGovernor;
  adapter?: SimulatorAdapter;
  observeSeat?: (
    identity: SeatIdentity,
  ) => Promise<
    { identity: SimulatorOwner; processes?: SimulatorOwner["processes"]; status: string } | undefined
  >;
  /** Best-effort: live processes that name each external device, mapped to seats where provable. */
  attribute?: (
    devices: readonly SimulatorDevice[],
    inventory: readonly SimulatorDevice[],
  ) => Promise<ReadonlyMap<string, readonly SimulatorHolder[]>>;
  onChange?: () => void;
  clock?: () => number;
  processProbe?: typeof probeProcess;
  /** How long acquire waits on its boot before answering `booting`; the boot continues. */
  respondWithinMs?: number;
}) {
  const adapter = input.adapter ?? createSimctlAdapter();
  const now = input.clock ?? Date.now;
  const probe = input.processProbe ?? probeProcess;
  const respondWithinMs = input.respondWithinMs ?? 20_000;
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
  const rejected = (
    reason: SimulatorRejection,
    detail?: string,
    alternatives?: { deviceType: string; name: string; udid?: string }[],
  ): SimulatorResult => ({
    outcome: "rejected",
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(alternatives?.length ? { alternatives } : {}),
  });
  const revoked = () => rejected("authorization_revoked", "Owner authority ended during the request.");
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let operations: Promise<unknown> = Promise.resolve();
  const acquisitions = new Map<string, Promise<SimulatorResult>>();
  const acquisitionSelections = new Map<string, string>();
  /** Server-owned preparation by lease id; it outlives any request that started it. */
  const jobs = new Map<string, Promise<SimulatorResult>>();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operations.then(operation, operation);
    operations = result.catch(() => undefined);
    return result;
  };
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const resolve of [...waiters]) resolve();
  };
  const waitForChange = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
  const changed = () => {
    wake();
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
  const ownedBy = (leases: readonly SimulatorReservation[]) => ({
    ids: new Set(leases.flatMap((lease) => (lease.deviceId ? [lease.deviceId.toUpperCase()] : []))),
    names: new Set(leases.flatMap((lease) => (lease.deviceName ? [lease.deviceName] : []))),
  });
  const externals = (devices: readonly SimulatorDevice[], leases: readonly SimulatorReservation[]) => {
    const owned = ownedBy(leases).ids;
    return devices.filter((device) => active(device) && !owned.has(device.udid.toUpperCase()));
  };
  const externalActive = async (excluding?: string) => {
    const [devices, leases] = await Promise.all([inventory(), reservations()]);
    return externals(devices, leases).filter((device) => device.udid !== excluding?.toUpperCase()).length;
  };
  const describeExternal = async (
    devices: readonly SimulatorDevice[],
    all: readonly SimulatorDevice[],
  ): Promise<ExternalSimulatorView[]> => {
    let holders: ReadonlyMap<string, readonly SimulatorHolder[]> = new Map();
    if (devices.length && input.attribute)
      holders = await input
        .attribute(devices, all)
        .catch(() => new Map<string, readonly SimulatorHolder[]>());
    return devices.map((device) => ({
      udid: device.udid,
      name: device.name,
      state: device.state,
      runtime: device.runtime,
      ...(device.deviceType === undefined ? {} : { deviceType: device.deviceType }),
      holders: [...(holders.get(device.udid) ?? [])].slice(0, 32),
    }));
  };
  const prove = async (identity: SeatIdentity): Promise<SimulatorOwner | undefined> => {
    const observed = await input.observeSeat?.(identity);
    if (!observed || !sameSeat(observed.identity, identity) || observed.identity.processes.length === 0)
      return undefined;
    if ((await Promise.all(observed.identity.processes.map(probe))).some((state) => state !== "live"))
      return undefined;
    return observed.identity;
  };
  const matchesNativeOwner = (lease: SimulatorReservation, owner: SimulatorOwner) =>
    sameNativeSeat(lease, owner) &&
    lease.pane === owner.pane &&
    isDeepStrictEqual(lease.ownerProcesses, owner.processes) &&
    isDeepStrictEqual(lease.binding, owner.binding);
  const matchesOwner = (lease: SimulatorReservation, owner: SimulatorOwner) =>
    lease.holderId === owner.holderId && matchesNativeOwner(lease, owner);
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
  const booting = (lease: SimulatorReservation, requested?: string): SimulatorResult => ({
    outcome: "booting",
    lease: view(lease, requested),
    retryAfterMs: RETRY_MS,
  });
  // Each effect is durably marked first and is attempted once. Missing replies
  // are reconciled by UUID inventory; a name never establishes device ownership.
  const removeStopped = async (
    lease: SimulatorReservation,
    authority?: SimulatorRequestOptions,
  ): Promise<SimulatorResult> => {
    if (!lease.deviceId) return held(lease);
    if (!(await authorized(authority))) return held(lease);
    // Retain every stopped device, including ones created by this manager.
    // Deletion belongs to an explicit owner tidy, never lease settlement.
    return forget(lease);
  };
  const reconcile = async (
    lease: SimulatorReservation,
    cleanup = false,
    authority?: SimulatorRequestOptions,
  ): Promise<SimulatorResult> => {
    if (!lease.deviceId) {
      // A reservation that never submitted a native effect and whose
      // preparation is gone (for example across a restart) frees its slot.
      if (cleanup && lease.phase === "reserved" && !jobs.has(lease.id)) return forget(lease);
      return held(lease);
    }
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
      // An idle or abandoned lease whose device never left Shutdown is not
      // booting; it is cleaned up like an unbooted device.
      else if (cleanup && device.state === "Shutdown" && !jobs.has(lease.id))
        return removeStopped(lease, authority);
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

  /** Prefer booted-before idle family matches, then cold matches, then create. */
  const choose = async (
    request: SimulatorAcquireRequest,
    devices: readonly SimulatorDevice[],
    leases: readonly SimulatorReservation[],
    catalog?: SimulatorCatalog,
  ): Promise<Plan> => {
    const owned = ownedBy(leases);
    const free = (device: SimulatorDevice) =>
      device.available && !owned.ids.has(device.udid.toUpperCase()) && !owned.names.has(device.name);
    if (request.deviceId) {
      const device = devices.find((row) => row.udid.toUpperCase() === request.deviceId!.toUpperCase());
      if (!device) return { kind: "refuse", detail: `No simulator has UDID ${request.deviceId}.` };
      const holder = leases.find((lease) => lease.deviceId?.toUpperCase() === device.udid.toUpperCase());
      if (device.available && holder)
        return {
          kind: "waiting",
          detail: `Requested device ${device.name} (${device.udid}) is leased to seat ${holder.seatId}${holder.holderId ? ` holder ${holder.holderId}` : ""}. Wait for that exact device; no alternative will be used.`,
        };
      if (!free(device))
        return {
          kind: "refuse",
          detail: `${device.name} (${device.udid}) is leased or unavailable.`,
        };
      if (device.state === "Shutting Down")
        return {
          kind: "waiting",
          detail: `${device.name} is shutting down; wait for that device to be Shutdown.`,
        };
      return { kind: "existing", device };
    }
    const deviceType = request.deviceType!,
      runtime = request.runtime!;
    const idle = devices
      .filter((device) => device.runtime === runtime && device.state === "Shutdown" && free(device))
      .sort((a, b) => a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid));
    const compatible = idle.filter(
      (device) =>
        device.deviceType !== undefined &&
        (request.exact ? device.deviceType === deviceType : sameFamily(device.deviceType, deviceType)),
    );
    // A cold exact model still has a costly first boot. Prefer a previously used
    // family match, while explicit model and UDID constraints remain strict.
    const warmed = compatible.filter((device) => device.lastUsedAt !== undefined);
    const candidates = warmed.length ? warmed : compatible;
    const exact = candidates.find((device) => device.deviceType === deviceType);
    if (exact) return { kind: "existing", device: exact };
    if (!request.exact) {
      const close = candidates.find(
        (device) => device.deviceType !== undefined && family(device.deviceType) === family(deviceType),
      );
      if (close) return { kind: "existing", device: close };
      const sameKind = candidates.find(
        (device) => device.deviceType !== undefined && sameFamily(device.deviceType, deviceType),
      );
      if (sameKind) return { kind: "existing", device: sameKind };
    }
    const busy = devices.find(
      (device) =>
        device.available &&
        device.runtime === runtime &&
        device.deviceType &&
        (request.exact ? device.deviceType === deviceType : sameFamily(device.deviceType, deviceType)),
    );
    if (busy)
      return {
        kind: "waiting",
        detail: `Matching device ${busy.name} (${busy.udid}) is busy; wait for it rather than creating a replacement.`,
      };
    if (!catalog) return { kind: "create", deviceType, runtime };
    const typeInstalled = catalog.deviceTypes.some((row) => row.identifier === deviceType);
    const runtimeInstalled = catalog.runtimes.includes(runtime);
    if (typeInstalled && runtimeInstalled) return { kind: "create", deviceType, runtime };
    const alternatives = [
      ...devices
        .filter(
          (device) =>
            device.available &&
            device.runtime === runtime &&
            device.deviceType !== undefined &&
            sameFamily(device.deviceType, deviceType),
        )
        .map((device) => ({ deviceType: device.deviceType!, name: device.name, udid: device.udid })),
      ...catalog.deviceTypes
        .filter((row) => row.identifier !== deviceType && sameFamily(row.identifier, deviceType))
        .map((row) => ({ deviceType: row.identifier, name: row.name })),
    ].slice(0, 32);
    return {
      kind: "refuse",
      detail: !runtimeInstalled
        ? `Runtime ${runtime} is not installed. Installed: ${catalog.runtimes.slice(0, 8).join(", ") || "none"}.`
        : `Device type ${deviceType} is not installed${request.exact ? " and exact was requested" : ""}.`,
      alternatives,
    };
  };

  const blockersFor = async (
    reason: "simulator_capacity" | "shared_capacity" | "pressure",
    snapshot: ResourceSnapshot,
    hint?: string,
  ): Promise<SimulatorResult> => {
    const leases = await reservations();
    const devices = await inventory().catch(() => [] as SimulatorDevice[]);
    const external = await describeExternal(externals(devices, leases), devices);
    const blockers: SimulatorBlockers = {
      simulatorSlots: snapshot.capacity.simulatorSlots,
      heavySlots: snapshot.capacity.heavySlots,
      leases: leases.map((lease) => ({
        id: lease.id,
        seatId: lease.seatId,
        ...(lease.holderId === undefined ? {} : { holderId: lease.holderId }),
        phase: lease.phase,
        ...(lease.deviceName === undefined ? {} : { deviceName: lease.deviceName }),
        ...(lease.deviceId === undefined ? {} : { deviceId: lease.deviceId }),
      })),
      external,
      heavy: snapshot.leases
        .filter((lease) => lease.kind === "heavy")
        .map((lease) => ({
          ...(lease.seatId === undefined ? {} : { seatId: lease.seatId }),
          ...(lease.executable === undefined ? {} : { executable: lease.executable }),
          ...(lease.pid === undefined ? {} : { pid: lease.pid }),
        })),
      ...(reason === "pressure"
        ? {
            pressure: {
              ...(snapshot.pressure.reason === undefined ? {} : { reason: snapshot.pressure.reason }),
              loadRatio: snapshot.pressure.loadRatio,
              availableMemoryMb: snapshot.pressure.availableMemoryMb,
            },
          }
        : {}),
    };
    return {
      outcome: "waiting",
      reason,
      blockers,
      retryAfterMs: RETRY_MS,
      hint: hint ?? hintFor(reason, blockers),
    };
  };

  /** Each stage runs in the serial section; the long boot wait does not block other seats. */
  const prepare = async (
    lease: SimulatorReservation,
    request: SimulatorAcquireRequest,
    owner: SimulatorOwner,
  ): Promise<SimulatorResult> => {
    const authority: SimulatorRequestOptions =
      request.authorize === undefined ? {} : { authorize: request.authorize };
    const requested = request.deviceId ? undefined : request.deviceType;
    const stage = await serial(async (): Promise<SimulatorResult | SimulatorReservation> => {
      try {
        const current = await prove(owner);
        if (!current || !matchesOwner(lease, current)) {
          await forget(lease);
          return rejected("stale_owner");
        }
        if (!(await authorized(authority))) {
          if (lease.phase === "reserved") await forget(lease);
          return revoked();
        }
        if (lease.phase === "reserved") {
          const { policy } = await input.governor.snapshot();
          const devices = await inventory();
          const leases = await reservations();
          const others = leases.filter((entry) => entry.id !== lease.id);
          const pinned = lease.deviceId ? { ...request, deviceId: lease.deviceId } : request;
          let plan = await choose(pinned, devices, others);
          if (plan.kind === "create")
            plan = await choose(pinned, devices, others, await adapter.catalog().catch(() => undefined));
          if (plan.kind === "waiting") {
            await forget(lease);
            return blockersFor("simulator_capacity", await input.governor.snapshot(), plan.detail);
          }
          if (plan.kind === "refuse") {
            await forget(lease);
            return rejected("device_unavailable", plan.detail, plan.alternatives);
          }
          const excluding = plan.kind === "existing" ? plan.device.udid.toUpperCase() : undefined;
          const occupancy =
            externals(devices, leases).filter((device) => device.udid !== excluding).length + leases.length;
          if (occupancy > policy.simulatorSlots) {
            await forget(lease);
            return rejected("capacity", "Another simulator was booted while this lease was admitted; retry.");
          }
          if (!(await authorized(authority))) {
            await forget(lease);
            return revoked();
          }
          if (plan.kind === "existing") {
            const device = plan.device;
            return update(lease, {
              phase:
                device.state === "Booted"
                  ? "booted"
                  : device.state === "Booting"
                    ? "boot-submitted"
                    : "created",
              deviceId: device.udid.toUpperCase(),
              deviceName: device.name,
              deviceType: device.deviceType ?? request.deviceType ?? "unknown",
              runtime: device.runtime,
            });
          }
          const deviceName = `Clankie-${randomUUID()}`;
          lease = await update(lease, {
            phase: "create-submitted",
            deviceName,
            deviceType: plan.deviceType,
            runtime: plan.runtime,
          });
          if (!(await authorized(authority))) {
            await forget(lease);
            return revoked();
          }
          let deviceId: string;
          try {
            deviceId = await adapter.create(deviceName, plan.deviceType, plan.runtime);
          } catch {
            return held(await update(lease, { phase: "create-uncertain" }));
          }
          lease = await update(lease, { phase: "created", deviceId });
        }
        return lease;
      } catch {
        return held(lease);
      }
    });
    if (!("token" in stage)) return stage;
    lease = stage;
    if (lease.phase === "booted") return { outcome: "acquired", lease: view(lease, requested) };
    // Mark the boot, then wait for it outside the serial section.
    const submitted = await serial(async (): Promise<SimulatorResult | SimulatorReservation> => {
      try {
        if (lease.phase === "boot-submitted") return lease;
        const devices = await inventory();
        const created = deviceFor(lease, devices);
        if (!created || !created.available) return held(lease);
        if (created.state === "Booted") return update(lease, { phase: "booted" });
        if (created.state !== "Shutdown") return held(lease);
        const live = await prove(owner);
        const { policy } = await input.governor.snapshot();
        const leases = await reservations();
        const occupancy = externals(devices, leases).length + leases.length;
        if (!(await authorized(authority))) return revoked();
        if (!live || !matchesOwner(lease, live) || occupancy > policy.simulatorSlots)
          return reconcile(lease, true);
        lease = await update(lease, { phase: "boot-submitted", lastUsedAtMs: now() });
        if (!(await authorized(authority))) {
          await update(lease, { phase: "created" });
          return revoked();
        }
        return lease;
      } catch {
        return held(lease);
      }
    });
    if (!("token" in submitted)) return submitted;
    lease = submitted;
    if (lease.phase === "booted") return { outcome: "acquired", lease: view(lease, requested) };
    let bootFailed = false;
    try {
      await adapter.boot(lease.deviceId!);
    } catch {
      bootFailed = true;
    }
    return serial(async () => {
      try {
        const current = (await find(lease.id)) ?? lease;
        if (current.token !== lease.token) return held(lease);
        const device = deviceFor(current, await inventory());
        if (device?.state === "Booted" && ["boot-submitted", "boot-uncertain"].includes(current.phase)) {
          lease = await update(current, { phase: "booted" });
          return { outcome: "acquired", lease: view(lease, requested) } as const;
        }
        if (current.phase === "booted")
          return { outcome: "acquired", lease: view(current, requested) } as const;
        if (bootFailed && current.phase === "boot-submitted")
          return held(await update(current, { phase: "boot-uncertain" }));
        return held(current);
      } catch {
        return held(lease);
      }
    });
  };
  const startJob = (
    lease: SimulatorReservation,
    request: SimulatorAcquireRequest,
    owner: SimulatorOwner,
  ): Promise<SimulatorResult> => {
    const running = jobs.get(lease.id);
    if (running) return running;
    const job = prepare(lease, request, owner)
      .catch((): SimulatorResult => held(lease))
      .finally(() => {
        jobs.delete(lease.id);
        changed();
      });
    jobs.set(lease.id, job);
    return job;
  };
  /** Answer within the bound; the job keeps running when the answer is `booting`. */
  const respond = async (
    job: Promise<SimulatorResult>,
    lease: SimulatorReservation,
    requested?: string,
  ): Promise<SimulatorResult> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), respondWithinMs);
    });
    try {
      const result = await Promise.race([job, pending]);
      if (result) return result;
    } finally {
      clearTimeout(timeout);
    }
    return booting((await find(lease.id)) ?? lease, requested);
  };
  /** An existing lease: report it, resume its preparation, or say why it is stuck. */
  const resume = async (
    lease: SimulatorReservation,
    request: SimulatorAcquireRequest,
    owner: SimulatorOwner,
  ): Promise<SimulatorResult> => {
    const running = jobs.get(lease.id);
    if (running) return respond(running, lease);
    if (lease.phase === "booted") {
      const device = lease.deviceId
        ? (await inventory().catch(() => [] as SimulatorDevice[])).find(
            (row) => row.udid.toUpperCase() === lease.deviceId!.toUpperCase(),
          )
        : undefined;
      return device?.state === "Booted" ? { outcome: "acquired", lease: view(lease) } : held(lease);
    }
    // Reserved for over a minute with no preparation here, or created and
    // stopped: the seat's own retry finishes the work instead of stranding it.
    const abandoned = lease.phase === "reserved" && now() - lease.createdAtMs > 60_000;
    if (abandoned || lease.phase === "created") return respond(startJob(lease, request, owner), lease);
    if (["boot-submitted", "boot-uncertain"].includes(lease.phase) && lease.deviceId) {
      const device = (await inventory().catch(() => [] as SimulatorDevice[])).find(
        (row) => row.udid.toUpperCase() === lease.deviceId!.toUpperCase(),
      );
      if (device?.state === "Booted")
        return serial(async () => {
          const current = await find(lease.id);
          if (!current) return rejected("lease_unavailable");
          return { outcome: "acquired" as const, lease: view(await update(current, { phase: "booted" })) };
        });
      if (device?.state === "Booting") return booting(lease);
      // The boot that was submitted died with its process (for example a
      // service restart). Submitting it again for the same seat is safe.
      if (device?.state === "Shutdown")
        return respond(startJob(await update(lease, { phase: "created" }), request, owner), lease);
    }
    if (BOOTING_PHASES.has(lease.phase)) return booting(lease);
    return held(lease);
  };

  const acquire = async (request: SimulatorAcquireRequest): Promise<SimulatorResult> => {
    if (closed) return rejected("service_restarting", "The simulator manager is stopping.");
    if (!request.holderId)
      return rejected(
        "owner_unavailable",
        "A task holder is required; refresh the native resource hook or supply your own stable holderId. A seat alone cannot identify a native subagent.",
      );
    if (!request.deviceId && (!request.deviceType || !request.runtime))
      return rejected("device_unavailable", "Give deviceType and runtime, or the deviceId to lease.");
    const owner = await prove(request);
    if (!(await authorized(request))) return revoked();
    if (!owner) return rejected("owner_unavailable", "The seat's live native occupant could not be proven.");
    const existing = (await reservations()).find((lease) => sameSeat(lease, owner));
    if (!(await authorized(request))) return revoked();
    if (existing) {
      if (!matchesOwner(existing, owner)) return rejected("stale_owner");
      if (
        (request.deviceId &&
          existing.deviceId &&
          existing.deviceId.toUpperCase() !== request.deviceId.toUpperCase()) ||
        (request.exact &&
          request.deviceType &&
          existing.deviceType &&
          existing.deviceType !== request.deviceType) ||
        (request.runtime && existing.runtime && existing.runtime !== request.runtime)
      )
        return rejected(
          "lease_unavailable",
          `This holder already holds lease ${existing.id} on ${existing.deviceName ?? "a pending device"} (${existing.deviceId ?? "UDID pending"}); it does not match this request. Release it first.`,
        );
      return resume(existing, request, owner);
    }
    const resourceSnapshot = await input.governor.snapshot();
    const { policy } = resourceSnapshot;
    if (policy.simulatorSlots === 0)
      return rejected("simulators_disabled", "The owner's simulator limit is 0.");
    let devices: readonly SimulatorDevice[];
    try {
      devices = await inventory();
    } catch {
      return rejected("inventory_unavailable", "CoreSimulator inventory could not be read.");
    }
    // Refuse an impossible request before taking a slot.
    const leases = await reservations();
    let preview = await choose(request, devices, leases);
    if (preview.kind === "create")
      preview = await choose(request, devices, leases, await adapter.catalog().catch(() => undefined));
    if (preview.kind === "refuse")
      return rejected("device_unavailable", preview.detail, preview.alternatives);
    // Resolve an existing target even while another holder owns it. Waiting never
    // changes an exact request or creates a replacement for a busy existing device.
    const targetPlan = await choose(
      request,
      devices.map((device) => ({ ...device, state: "Shutdown" })),
      [],
    );
    const queued = await input.governor
      .queueSimulator({
        seatId: owner.seatId,
        occupantId: owner.occupantId,
        holderId: owner.holderId!,
        ...(owner.fleet ? { fleet: owner.fleet } : {}),
        ownerProcesses: [...owner.processes],
        ...(request.ticketId ? { ticketId: request.ticketId } : {}),
        selection: {
          ...(request.deviceId ? { deviceId: request.deviceId.toUpperCase() } : {}),
          ...(request.deviceType ? { deviceType: request.deviceType } : {}),
          ...(request.runtime ? { runtime: request.runtime } : {}),
          exact: request.exact ?? false,
          ...(targetPlan.kind === "existing" ? { targetDeviceId: targetPlan.device.udid.toUpperCase() } : {}),
        },
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.startsWith("Simulator ticket")) return undefined;
        throw error;
      });
    if (!queued)
      return rejected(
        "ticket_unavailable",
        "Ticket expired, was cancelled, or belongs to a different selection. Cancel the original ticket before changing it.",
      );
    const previous = resourceSnapshot.queue.find((entry) => entry.id === queued.id);
    if (!previous || previous.deviceId !== queued.simulator?.targetDeviceId) changed();
    const target = queued.simulator?.targetDeviceId;
    if (target) preview = await choose({ ...request, deviceId: target }, devices, leases);
    const waiting = async (result: SimulatorResult): Promise<SimulatorResult> => {
      if (result.outcome !== "waiting") return result;
      const ticket = (await input.governor.snapshot()).queue.find((entry) => entry.id === queued.id);
      return { ...result, ...(ticket ? { ticket } : {}) };
    };
    if (
      !request.deviceId &&
      preview.kind === "existing" &&
      preview.device.state !== "Shutdown" &&
      !leases.some((lease) => lease.deviceId === preview.device.udid.toUpperCase())
    )
      return waiting(await blockersFor("simulator_capacity", await input.governor.snapshot()));
    if (preview.kind === "waiting")
      return waiting(
        await blockersFor("simulator_capacity", await input.governor.snapshot(), preview.detail),
      );
    if (preview.kind === "refuse") {
      await input.governor.cancelSimulatorTicket(queued.id, owner);
      changed();
      return rejected("device_unavailable", preview.detail, preview.alternatives);
    }
    const excluding = request.deviceId && preview.kind === "existing" ? preview.device.udid : undefined;
    let authorityLost = false,
      inventoryLost = false;
    let admission: Awaited<ReturnType<FleetResourceGovernor["tryAcquireSimulator"]>>;
    try {
      admission = await input.governor.tryAcquireSimulator({
        ticketId: queued.id,
        ...(preview.kind === "existing"
          ? {
              deviceId: preview.device.udid.toUpperCase(),
              ...(preview.device.deviceType ? { deviceType: preview.device.deviceType } : {}),
              runtime: preview.device.runtime,
            }
          : {}),
        seatId: owner.seatId,
        occupantId: owner.occupantId,
        ...(owner.holderId === undefined ? {} : { holderId: owner.holderId }),
        ...(owner.fleet === undefined ? {} : { fleet: owner.fleet }),
        pane: owner.pane,
        ownerProcesses: [...owner.processes],
        ...(owner.binding === undefined ? {} : { binding: owner.binding }),
        externalActive: async () => {
          let count: number;
          try {
            count = await externalActive(excluding);
          } catch (error) {
            inventoryLost = true;
            throw error;
          }
          if (request.waitSignal?.aborted || !(await authorized(request))) {
            authorityLost = true;
            throw new Error("Simulator authorization changed");
          }
          return count;
        },
      });
    } catch (error) {
      if (authorityLost) {
        await input.governor.cancelSimulatorTicket(queued.id, owner);
        changed();
        return revoked();
      }
      if (inventoryLost)
        return rejected("inventory_unavailable", "CoreSimulator inventory could not be read.");
      if (error instanceof SimulatorsDisabledError)
        return rejected("simulators_disabled", "The owner's simulator limit is 0.");
      if (error instanceof DOMException && error.name === "AbortError")
        return rejected("service_restarting", "The resource governor is stopping.");
      throw error;
    }
    if (!admission.admitted) return waiting(await blockersFor(admission.reason, admission.snapshot));
    changed();
    return respond(
      startJob(admission.lease, request, owner),
      admission.lease,
      request.deviceId ? undefined : request.deviceType,
    );
  };
  const manager = {
    /** Read-only advice; acquire rechecks inventory and authority before effects. */
    async plan(request: SimulatorAcquireRequest): Promise<SimulatorResult> {
      if (closed) return rejected("service_restarting", "The simulator manager is stopping.");
      if (!request.holderId)
        return rejected(
          "owner_unavailable",
          "A task holder is required; refresh the native resource hook or supply your own stable holderId.",
        );
      if (!request.deviceId && (!request.deviceType || !request.runtime))
        return rejected("device_unavailable", "Give deviceType and runtime, or the deviceId to lease.");
      const owner = await prove(request);
      if (!(await authorized(request))) return revoked();
      if (!owner)
        return rejected("owner_unavailable", "The seat's live native occupant could not be proven.");
      try {
        const devices = await inventory();
        const leases = await reservations();
        const existing = leases.find((lease) => sameSeat(lease, owner));
        if (!(await authorized(request))) return revoked();
        if (existing) return matchesOwner(existing, owner) ? held(existing) : rejected("stale_owner");
        let plan = await choose(request, devices, leases);
        if (plan.kind === "create")
          plan = await choose(request, devices, leases, await adapter.catalog().catch(() => undefined));
        const { policy } = await input.governor.snapshot();
        if (!(await authorized(request))) return revoked();
        if (policy.simulatorSlots === 0)
          return rejected("simulators_disabled", "The owner's simulator limit is 0.");
        if (plan.kind === "waiting")
          return blockersFor("simulator_capacity", await input.governor.snapshot(), plan.detail);
        if (plan.kind === "refuse") return rejected("device_unavailable", plan.detail, plan.alternatives);
        return {
          outcome: "planned",
          choice: plan.kind === "create" ? "create" : "reuse",
          simulatorIdleMs: policy.simulatorIdleMs,
        };
      } catch {
        return rejected("inventory_unavailable", "CoreSimulator inventory could not be read.");
      }
    },
    acquire(request: SimulatorAcquireRequest): Promise<SimulatorResult> {
      const key = JSON.stringify([
        request.fleet ?? "default",
        request.seatId,
        request.occupantId,
        request.holderId,
      ]);
      const selection = JSON.stringify([
        request.deviceId?.toUpperCase(),
        request.deviceType,
        request.runtime,
        request.exact ?? false,
      ]);
      const pending = acquisitions.get(key);
      if (pending && acquisitionSelections.get(key) !== selection)
        return Promise.resolve(
          rejected(
            "lease_unavailable",
            "This holder has a different acquire pending; cancel its ticket before changing selection.",
          ),
        );
      // Serialize a holder's requests, but never reuse another request's grant:
      // its exact UDID/model/runtime may differ, even while boot is in flight.
      if (pending) return pending.then(() => manager.acquire(request));
      const result = (async () => {
        const deadline = Date.now() + (request.waitMs ?? 0);
        let result = await acquire(request);
        let ticketId = result.outcome === "waiting" ? result.ticket?.id : undefined;
        while ((result.outcome === "waiting" || result.outcome === "booting") && Date.now() < deadline) {
          if (closed) return rejected("service_restarting");
          if (!(await authorized(request))) {
            if (ticketId) await input.governor.cancelSimulatorTicket(ticketId, request);
            return revoked();
          }
          await waitForChange(Math.min(RETRY_MS, deadline - Date.now()), request.waitSignal);
          if (request.waitSignal?.aborted) {
            if (result.outcome === "booting") return result;
            if (ticketId) await input.governor.cancelSimulatorTicket(ticketId, request);
            changed();
            return { outcome: "cancelled" } as const;
          }
          result = await acquire({ ...request, ...(ticketId ? { ticketId } : {}) });
          if (result.outcome === "waiting") ticketId = result.ticket?.id ?? ticketId;
        }
        return result;
      })()
        .then((result): SimulatorResult => {
          // A reservation can still lack a device when a poll arrives. Check
          // again after preparation rather than treating that absence as mismatch.
          if (
            result.outcome === "acquired" &&
            ((request.deviceId && result.lease.deviceId?.toUpperCase() !== request.deviceId.toUpperCase()) ||
              (request.exact && request.deviceType && result.lease.deviceType !== request.deviceType) ||
              (request.runtime && result.lease.runtime !== request.runtime))
          )
            return rejected(
              "lease_unavailable",
              "This holder's acquired device does not match the requested device; inspect status and release its original lease before changing devices.",
            );
          return result;
        })
        .finally(() => {
          acquisitions.delete(key);
          acquisitionSelections.delete(key);
        });
      acquisitions.set(key, result);
      acquisitionSelections.set(key, selection);
      return result;
    },
    async cancel(
      id: string,
      owner: SimulatorOwner,
      authority?: SimulatorRequestOptions,
    ): Promise<SimulatorResult> {
      const current = await prove(owner);
      if (!(await authorized(authority))) return revoked();
      if (!current || !sameSeat(current, owner)) return rejected("stale_owner");
      const cancelled = await input.governor.cancelSimulatorTicket(id, current);
      if (!cancelled) return rejected("ticket_unavailable");
      changed();
      return { outcome: "cancelled" } as const;
    },
    /** Read-only preflight for install/launch/drive clients; never adopts another holder. */
    async verify(
      id: string,
      deviceId: string,
      owner: SimulatorOwner,
      authority?: SimulatorRequestOptions,
    ): Promise<SimulatorResult> {
      const lease = await find(id);
      const current = await prove(owner);
      if (!(await authorized(authority))) return revoked();
      if (!lease) return rejected("lease_unavailable");
      if (!current || !matchesOwner(lease, owner) || !matchesOwner(lease, current))
        return rejected("stale_owner");
      if (lease.deviceId?.toUpperCase() !== deviceId.toUpperCase())
        return rejected("lease_unavailable", "The requested device is not this holder's leased device.");
      const device = deviceFor(lease, await inventory());
      if (!(await authorized(authority))) return revoked();
      if (lease.phase !== "booted" || device?.state !== "Booted")
        return rejected("lease_unavailable", "This holder's device is not confirmed booted.");
      return { outcome: "acquired", lease: view(lease) };
    },
    async touch(
      id: string,
      owner: SimulatorOwner,
      authority?: SimulatorRequestOptions,
    ): Promise<SimulatorResult> {
      return serial(async () => {
        const lease = await find(id);
        if (!lease) return rejected("lease_unavailable");
        const current = await prove(owner);
        if (!(await authorized(authority))) return revoked();
        if (!current || !matchesOwner(lease, owner) || !matchesOwner(lease, current))
          return rejected("stale_owner");
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
        if (!lease) return rejected("lease_unavailable");
        const current = await prove(owner);
        if (!(await authorized(authority))) return revoked();
        if (!current || !matchesOwner(lease, owner) || !matchesOwner(lease, current))
          return rejected("stale_owner");
        try {
          return await reconcile(lease, true, authority);
        } catch {
          return held(lease);
        }
      });
    },
    async observeSeatState(identity: SimulatorOwner, _status: string): Promise<void> {
      // Harness turns do not renew simulator use. Only touch/acquire is activity.
      if ((await reservations()).some((lease) => matchesNativeOwner(lease, identity))) await manager.tick();
    },
    async observeSeatExited(identity: SimulatorOwner): Promise<void> {
      await serial(async () => {
        for (const lease of await reservations()) {
          if (!matchesNativeOwner(lease, identity) || identity.processes.length === 0) continue;
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
    async snapshot(): Promise<SimulatorStatusView> {
      const leases = await reservations();
      const views = leases.map((lease) => view(lease));
      const simulatorSlots = (await input.governor.snapshot().catch(() => undefined))?.policy.simulatorSlots;
      let devices: readonly SimulatorDevice[];
      try {
        devices = await inventory();
      } catch {
        return {
          leases: views,
          inventory: "unavailable",
          externalActive: null,
          ...(simulatorSlots === undefined ? {} : { simulatorSlots }),
        };
      }
      const usage = devices.some((device) => device.state === "Booted" || device.state === "Booting")
        ? await observeSimulatorUsage()
        : new Map();
      const external = (await describeExternal(externals(devices, leases), devices)).map((device) => ({
        ...device,
        usage: simulatorUsageFor(usage, device.udid),
      }));
      return {
        leases: views.map((lease) =>
          lease.deviceId ? { ...lease, usage: simulatorUsageFor(usage, lease.deviceId) } : lease,
        ),
        inventory: "available",
        externalActive: external.length,
        external,
        ...(simulatorSlots === undefined ? {} : { simulatorSlots }),
        ...(external.length ? { hint: externalHint(external) } : {}),
      };
    },
    /** Booted or booting devices no lease owns, with the whole inventory; no attribution. */
    async externalDevices(): Promise<{
      external: readonly SimulatorDevice[];
      inventory: readonly SimulatorDevice[];
    }> {
      const devices = await inventory();
      return { external: externals(devices, await reservations()), inventory: devices };
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
            const stale = lease.phase === "reserved" && now() - lease.createdAtMs >= 300_000;
            await reconcile(lease, exited || stale || now() - lease.lastUsedAtMs >= policy.simulatorIdleMs);
          } catch {
            /* Unknown inventory or command outcome never frees a slot. */
          }
        }
      });
    },
    /** Resolves when every preparation this manager started has settled. */
    async settled(): Promise<void> {
      while (jobs.size) await Promise.allSettled(jobs.values());
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
      closed = true;
      wake();
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return manager;
}

const deviceLabel = (device: ExternalSimulatorView) => {
  const seats = [...new Set(device.holders.flatMap((holder) => (holder.seatId ? [holder.seatId] : [])))];
  const processes = device.holders.filter((holder) => !holder.seatId);
  return `"${device.name}" ${device.udid} (${device.state}${
    seats.length
      ? `; used by seat ${seats.join(", ")}`
      : processes.length
        ? `; named by ${processes.map((holder) => `${holder.executable} PID ${holder.pid}`).join(", ")}`
        : "; no live process names it"
  })`;
};
const externalHint = (external: readonly ExternalSimulatorView[]) =>
  `${external.length} simulator(s) booted outside leases count against the limit and are never shut down by Clankie: ${external
    .map(deviceLabel)
    .join(
      "; ",
    )}. The seat using one can lease it with acquire {"seatId":...,"deviceId":"UDID"}, or shut it down with xcrun simctl shutdown UDID.`;
function hintFor(
  reason: "simulator_capacity" | "shared_capacity" | "pressure",
  blockers: SimulatorBlockers,
): string {
  const leases = blockers.leases.map(
    (lease) =>
      `seat ${lease.seatId}${lease.holderId ? ` holder ${lease.holderId}` : ""} (${lease.deviceName ?? "device pending"}, ${lease.phase})`,
  );
  if (reason === "pressure")
    return `Machine pressure is high (${blockers.pressure?.reason ?? "unknown"}; load/core ${blockers.pressure?.loadRatio.toFixed(2)}, ${Math.round(blockers.pressure?.availableMemoryMb ?? 0)} MiB available). Retry later.`;
  if (reason === "shared_capacity") {
    const heavy = blockers.heavy.map((entry) =>
      `${entry.seatId ?? (entry.pid ? `PID ${entry.pid}` : "unattributed")} ${entry.executable ?? ""}`.trim(),
    );
    return `All ${blockers.sharedSlots} shared heavy/simulator slots are busy: ${[...heavy.map((entry) => `heavy ${entry}`), ...leases.map((entry) => `simulator ${entry}`)].join("; ")}. Retry shortly; heavy commands finish on their own.`;
  }
  const parts = [
    ...(leases.length ? [`leased to ${leases.join(", ")}`] : []),
    ...(blockers.external.length ? [`outside leases: ${blockers.external.map(deviceLabel).join("; ")}`] : []),
  ];
  return `All ${blockers.simulatorSlots} simulator slot(s) are held — ${parts.join("; ") || "by an unknown holder"}. Retry after a release, ask the holding seat to release or lease its device, or ask the owner to raise --simulator-slots.`;
}
