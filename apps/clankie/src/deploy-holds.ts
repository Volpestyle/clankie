import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DeployHoldSchema, type DeployHold, type HoldOverride } from "@clankie/protocol/integrate";

/** Atomic replacement plus fsync: a process exit cannot turn a pass into a partial JSON file. */
export async function durableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function withDirectoryLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw Error(`Integration operation busy; retained lock: ${directory}`);
    throw error;
  }
  try {
    await durableJson(join(directory, "owner.json"), { pid: process.pid, at: new Date().toISOString() });
    return await work();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const Registry = z.object({
  holds: z.array(DeployHoldSchema),
  events: z.array(
    z.object({
      action: z.enum(["release", "override"]),
      hold: DeployHoldSchema,
      actor: z.string(),
      reason: z.string(),
      at: z.iso.datetime(),
      operation: z.string(),
    }),
  ),
});
export class DeployHolds {
  readonly directory: string;
  private readonly presence: ((hold: DeployHold) => Promise<DeployHold["presence"]>) | undefined;
  constructor(directory: string, presence?: (hold: DeployHold) => Promise<DeployHold["presence"]>) {
    this.directory = directory;
    this.presence = presence;
  }
  private get path(): string {
    return join(this.directory, "holds.json");
  }
  private async read(): Promise<z.infer<typeof Registry>> {
    try {
      return Registry.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { holds: [], events: [] };
      throw error;
    }
  }
  async list(): Promise<DeployHold[]> {
    const { holds } = await this.read();
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
  async acquire(
    input: Pick<DeployHold, "id" | "holder" | "reason" | "pane" | "seat">,
  ): Promise<DeployHold[]> {
    return withDirectoryLock(join(this.directory, "landing.lock"), async () => {
      const registry = await this.read();
      const existing = registry.holds.find((h) => h.id === input.id);
      if (
        existing &&
        (existing.holder !== input.holder ||
          existing.reason !== input.reason ||
          existing.pane !== input.pane ||
          existing.seat !== input.seat)
      )
        throw Error("Hold ID already has a different owner/reason");
      if (!existing)
        registry.holds.push({ ...input, createdAt: new Date().toISOString(), presence: "unknown" });
      await durableJson(this.path, registry);
      return this.list();
    });
  }
  async release(id: string, actor: string, reason: string): Promise<DeployHold[]> {
    return withDirectoryLock(join(this.directory, "landing.lock"), async () => {
      const registry = await this.read();
      const hold = registry.holds.find((h) => h.id === id);
      if (!hold) throw Error("Unknown hold");
      registry.events.push({
        action: "release",
        hold,
        actor,
        reason,
        at: new Date().toISOString(),
        operation: "release",
      });
      registry.holds = registry.holds.filter((h) => h.id !== id);
      await durableJson(this.path, registry);
      return this.list();
    });
  }
  /** Hold acquisition and landing share a lock; a hold cannot race the push/deploy admission. */
  async landing<T>(operation: string, overrides: HoldOverride[], work: () => Promise<T>): Promise<T> {
    return withDirectoryLock(join(this.directory, "landing.lock"), async () => {
      const registry = await this.read();
      const ids = new Set(overrides.map((o) => o.holdId));
      if (
        ids.size !== overrides.length ||
        overrides.some((o) => !registry.holds.some((h) => h.id === o.holdId))
      )
        throw Error("Override must name each existing hold exactly once");
      const blocked = registry.holds.filter((h) => !ids.has(h.id));
      if (blocked.length)
        throw Error(
          `Deploy held: ${blocked.map((h) => `${h.id} by ${h.holder}: ${h.reason} (since ${h.createdAt})`).join("; ")}`,
        );
      for (const override of overrides)
        registry.events.push({
          action: "override",
          hold: registry.holds.find((h) => h.id === override.holdId)!,
          actor: override.actor,
          reason: override.reason,
          at: new Date().toISOString(),
          operation,
        });
      if (overrides.length) await durableJson(this.path, registry);
      return work();
    });
  }
}
