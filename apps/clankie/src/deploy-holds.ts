import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  DEPLOY_HOLD_MAX_MINUTES,
  DeployHoldReceiptSchema,
  DeployHoldSchema,
  deployHoldExpiry,
  describeDeployHold,
  type DeployHold,
  type DeployHoldReceipt,
  type HoldOverride,
} from "@clankie/protocol/integrate";

/** Atomic replacement plus fsync: a process exit cannot turn a pass into a partial JSON file. */
export async function durableJson(path: string, value: unknown, guard?: () => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await guard?.();
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Another operation holds the directory lock; nothing ran. */
class IntegrationLockBusy extends Error {}

const LockOwnerSchema = z.object({ pid: z.number().int().positive(), at: z.iso.datetime() });
export type LockOwner = z.infer<typeof LockOwnerSchema>;

async function lockOwner(directory: string): Promise<LockOwner | undefined> {
  try {
    return LockOwnerSchema.parse(JSON.parse(await readFile(join(directory, "owner.json"), "utf8")));
  } catch {
    return undefined;
  }
}

const busy = (directory: string, owner?: LockOwner) =>
  new IntegrationLockBusy(
    `Integration operation busy; retained lock: ${directory}${owner ? ` (pid ${owner.pid} since ${owner.at})` : ""}`,
  );

/**
 * An owner that can never release its lock: it took the lock before this process started and
 * its pid is dead. An earlier process with this process's pid counts as dead. A missing owner
 * record means a crash between making the directory and writing the record.
 */
async function abandoned(directory: string, owner: LockOwner | undefined): Promise<boolean> {
  const since = owner ? Date.parse(owner.at) : (await stat(directory)).mtimeMs;
  if (since >= performance.timeOrigin) return false;
  if (!owner || owner.pid === process.pid) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Takes over a lock its owner died holding, such as a service restarted mid-operation
 * (VUH-2073). The lock moves aside in one rename and its owner record is checked again
 * there, so of two processes that find the same stale lock only one takes it.
 */
async function reclaim(directory: string): Promise<LockOwner | undefined> {
  let owner: LockOwner | undefined;
  try {
    owner = await lockOwner(directory);
    if (!(await abandoned(directory, owner))) throw busy(directory, owner);
    const aside = `${directory}.abandoned-${randomUUID()}`;
    await rename(directory, aside);
    if (JSON.stringify(await lockOwner(aside)) !== JSON.stringify(owner)) {
      // Someone took the lock over between the read and the move; hand it back.
      await rename(aside, directory).catch(() => undefined);
      throw busy(directory);
    }
    await rm(aside, { recursive: true, force: true });
    await mkdir(directory, { mode: 0o700 });
    return owner;
  } catch (error) {
    // Released, or taken by another process, while this one looked.
    if (["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw busy(directory);
    throw error;
  }
}

/** `reclaimed` runs, holding the lock, after taking over one a dead owner left. */
export async function withDirectoryLock<T>(
  directory: string,
  work: () => Promise<T>,
  reclaimed?: (owner: LockOwner | undefined) => Promise<void>,
): Promise<T> {
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  let previous: { owner: LockOwner | undefined } | undefined;
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    previous = { owner: await reclaim(directory) };
  }
  try {
    await durableJson(join(directory, "owner.json"), { pid: process.pid, at: new Date().toISOString() });
    if (previous) await reclaimed?.(previous.owner);
    return await work();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const Registry = z.object({
  holds: z.array(DeployHoldSchema),
  events: z.array(DeployHoldReceiptSchema),
});
export class DeployHeldError extends Error {
  readonly holds: DeployHold[];
  constructor(holds: DeployHold[], now = Date.now()) {
    super(`Deploy held: ${holds.map((h) => `${h.id} by ${describeDeployHold(h, now)}`).join("; ")}`);
    this.holds = holds;
  }
}
/**
 * Deploy holds keep the running service from being replaced while someone relies on it.
 * Every hold but the runtime canary's lifts on its own within DEPLOY_HOLD_MAX_MINUTES, leaving
 * a receipt; landing on main never waits for one (ADR 0240, VUH-2049).
 */
export class DeployHolds {
  readonly directory: string;
  private readonly presence: ((hold: DeployHold) => Promise<DeployHold["presence"]>) | undefined;
  private readonly now: () => number;
  constructor(
    directory: string,
    presence?: (hold: DeployHold) => Promise<DeployHold["presence"]>,
    now: () => number = Date.now,
  ) {
    this.directory = directory;
    this.presence = presence;
    this.now = now;
  }
  private get path(): string {
    return join(this.directory, "holds.json");
  }
  private get lock(): string {
    return join(this.directory, "landing.lock");
  }
  private async read(): Promise<z.infer<typeof Registry>> {
    try {
      return Registry.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { holds: [], events: [] };
      throw error;
    }
  }
  private expired(hold: DeployHold, now: number): number | undefined {
    const expiry = deployHoldExpiry(hold);
    return expiry !== undefined && expiry <= now ? expiry : undefined;
  }
  /** Moves every hold past its expiry into an `expire` receipt dated at that expiry. */
  private lapse(registry: z.infer<typeof Registry>): DeployHoldReceipt[] {
    const now = this.now();
    const lapsed: DeployHoldReceipt[] = [];
    registry.holds = registry.holds.filter((hold) => {
      const expiry = this.expired(hold, now);
      if (expiry === undefined) return true;
      const minutes = Math.round((expiry - Date.parse(hold.createdAt)) / 60_000);
      lapsed.push({
        action: "expire",
        hold,
        actor: "Clankie",
        reason: `${hold.holder}'s hold lifted on its own after ${minutes} minutes`,
        at: new Date(expiry).toISOString(),
        operation: "expire",
      });
      return false;
    });
    registry.events.push(...lapsed);
    return lapsed;
  }
  async list(): Promise<DeployHold[]> {
    const now = this.now();
    const holds = (await this.read()).holds.filter((hold) => this.expired(hold, now) === undefined);
    return Promise.all(
      holds.map(async (h) => ({
        ...h,
        presence:
          !h.pane && !h.seat
            ? ("person" as const)
            : ((await this.presence?.(h).catch(() => "unknown" as const)) ?? ("unknown" as const)),
      })),
    );
  }
  /** The latest receipts, oldest first. */
  async receipts(limit = 20): Promise<DeployHoldReceipt[]> {
    const registry = await this.read();
    this.lapse(registry);
    return registry.events.slice(-limit);
  }
  /** An operator hold names its minutes; without them a hold gets the ceiling, except the canary's. */
  async acquire(
    input: Pick<DeployHold, "id" | "holder" | "reason" | "pane" | "seat"> & { minutes?: number },
  ): Promise<DeployHold[]> {
    const minutes = input.minutes;
    if (
      minutes !== undefined &&
      (!Number.isInteger(minutes) || minutes < 1 || minutes > DEPLOY_HOLD_MAX_MINUTES)
    )
      throw Error(`A hold lasts 1 to ${DEPLOY_HOLD_MAX_MINUTES} minutes`);
    return withDirectoryLock(this.lock, async () => {
      const registry = await this.read();
      this.lapse(registry);
      const existing = registry.holds.find((h) => h.id === input.id);
      if (
        existing &&
        (existing.holder !== input.holder ||
          existing.reason !== input.reason ||
          existing.pane !== input.pane ||
          existing.seat !== input.seat)
      )
        throw Error("Hold ID already has a different owner/reason");
      if (!existing) {
        const createdAt = this.now();
        registry.holds.push({
          id: input.id,
          holder: input.holder,
          reason: input.reason,
          createdAt: new Date(createdAt).toISOString(),
          ...(minutes === undefined
            ? {}
            : { expiresAt: new Date(createdAt + minutes * 60_000).toISOString() }),
          ...(input.pane === undefined ? {} : { pane: input.pane }),
          ...(input.seat === undefined ? {} : { seat: input.seat }),
          presence: "unknown",
        });
      }
      await durableJson(this.path, registry);
      return this.list();
    });
  }
  /** Anyone's hold, by its holder, the lead or the owner; the receipt names holder, actor and reason. */
  async release(
    id: string,
    actor: string,
    reason: string,
    expected?: Pick<DeployHold, "holder" | "reason" | "pane" | "seat"> & { createdAt?: string },
  ): Promise<{ holds: DeployHold[]; receipt: DeployHoldReceipt }> {
    return withDirectoryLock(this.lock, async () => {
      const registry = await this.read();
      const lapsed = this.lapse(registry);
      const hold = registry.holds.find((h) => h.id === id);
      if (!hold) {
        const ended = [...registry.events].reverse().find((e) => e.hold.id === id && e.action !== "override");
        if (lapsed.length) await durableJson(this.path, registry);
        throw Error(ended ? `Hold ${id} already ended (${ended.action} at ${ended.at})` : "Unknown hold");
      }
      if (
        expected &&
        (hold.holder !== expected.holder ||
          hold.reason !== expected.reason ||
          hold.pane !== expected.pane ||
          hold.seat !== expected.seat ||
          (expected.createdAt !== undefined && hold.createdAt !== expected.createdAt))
      )
        throw Error("Hold ownership changed before release");
      const receipt: DeployHoldReceipt = {
        action: "release",
        hold,
        actor,
        reason,
        at: new Date(this.now()).toISOString(),
        operation: "release",
      };
      registry.events.push(receipt);
      registry.holds = registry.holds.filter((h) => h.id !== id);
      await durableJson(this.path, registry);
      return { holds: await this.list(), receipt };
    });
  }
  /** Records receipts for holds that reached their expiry; a busy lock leaves them for the next sweep. */
  async expire(): Promise<DeployHoldReceipt[]> {
    const now = this.now();
    if (!(await this.read()).holds.some((hold) => this.expired(hold, now) !== undefined)) return [];
    try {
      return await withDirectoryLock(this.lock, async () => {
        const registry = await this.read();
        const lapsed = this.lapse(registry);
        if (lapsed.length) await durableJson(this.path, registry);
        return lapsed;
      });
    } catch (error) {
      if (error instanceof IntegrationLockBusy) return [];
      throw error;
    }
  }
  /** Lifts holds at their expiry even when nothing reads the registry. */
  watch(
    onExpired: (receipt: DeployHoldReceipt) => void,
    onError: (error: unknown) => void,
    intervalMs = 15_000,
  ): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.expire()
        .then((receipts) => receipts.forEach(onExpired), onError)
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
  /** Runtime-update admission shares the hold lock, so a hold cannot race a deploy. */
  async landing<T>(
    operation: string,
    overrides: HoldOverride[],
    work: (overriddenHolds: DeployHold[]) => Promise<T>,
    admission?: {
      overrideAll?: { actor: string; reason: string };
      guard: () => Promise<void>;
    },
  ): Promise<T> {
    return withDirectoryLock(this.lock, async () => {
      const registry = await this.read();
      const lapsed = this.lapse(registry);
      await admission?.guard();
      if (admission?.overrideAll)
        overrides = registry.holds.map((hold) => ({ holdId: hold.id, ...admission.overrideAll! }));
      // A reviewed hold that lifted meanwhile needs no override.
      else overrides = overrides.filter((o) => !lapsed.some((receipt) => receipt.hold.id === o.holdId));
      const ids = new Set(overrides.map((o) => o.holdId));
      if (
        ids.size !== overrides.length ||
        overrides.some((o) => !registry.holds.some((h) => h.id === o.holdId))
      )
        throw Error("Override must name each existing hold exactly once");
      const blocked = registry.holds.filter((h) => !ids.has(h.id));
      if (blocked.length) {
        if (lapsed.length) await durableJson(this.path, registry);
        throw new DeployHeldError(blocked, this.now());
      }
      for (const override of overrides)
        registry.events.push({
          action: "override",
          hold: registry.holds.find((h) => h.id === override.holdId)!,
          actor: override.actor,
          reason: override.reason,
          at: new Date(this.now()).toISOString(),
          operation,
        });
      if (overrides.length || lapsed.length) await durableJson(this.path, registry, admission?.guard);
      return work(registry.holds.filter((hold) => ids.has(hold.id)));
    });
  }
}
