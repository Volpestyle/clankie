import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  collectLinearScoped,
  createLocalTracker,
  planLinearMirrorEvent,
  TRACKER_LEAD,
  TRACKER_OWNER,
  type LinearImportSnapshot,
  type LinearMirrorDrift,
  type LinearMirrorEvent,
  type LinearRecord,
  type LocalTrackerBackend,
  type TrackerActor,
} from "@clankie/work-items";
import { z } from "zod";
import { linearActorMap } from "./linear-import.ts";

/**
 * Mirror 2 (VUH-1965): Linear webhooks keep an imported scratch store current.
 * Owner-enabled per scratch store and project; nothing mirrors by default.
 * Linear stays authoritative (ADR 0181 amendment); mirror failures never touch wakes.
 */

const LINEAR_MIRROR_ACTIONS = ["enable", "disable", "status"] as const;
export type LinearMirrorAction = (typeof LINEAR_MIRROR_ACTIONS)[number];

const DRIFT_RETAINED = 50;
/** Drift repair re-reads at most this many issues for one event. */
const DRIFT_MAX_ISSUES = 5;

const DriftReportSchema = z.object({
  at: z.string(),
  eventId: z.string(),
  type: z.string(),
  action: z.string(),
  references: z.array(z.object({ type: z.string(), id: z.string() })),
  outcome: z.enum(["repaired", "unresolved", "failed"]),
  outside: z.array(z.string()).optional(),
  requests: z.number().int().nonnegative(),
  error: z.string().optional(),
});
type LinearMirrorDriftReport = z.infer<typeof DriftReportSchema>;

const BindingSchema = z.object({
  scratch: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  enabled: z.boolean(),
  updatedAt: z.string(),
  counters: z.object({
    applied: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    ignored: z.number().int().nonnegative(),
    drift: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  lastEventAt: z.string().optional(),
  lastError: z.string().optional(),
  drift: z.array(DriftReportSchema),
});
type Binding = z.infer<typeof BindingSchema>;
const RegistrySchema = z.object({
  schemaVersion: z.literal(1),
  mirrors: z.record(z.string(), BindingSchema),
});
type Registry = z.infer<typeof RegistrySchema>;

/** The connected, read-only Linear session drift repair reads through. */
interface LinearMirrorSession {
  readonly binding: { workspaceId: string; userId: string };
  readonly access: () => Promise<unknown>;
  readonly query: (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly requests: () => number;
}

export interface LinearMirrorsOptions {
  /** The `tracker-imports` directory holding scratch stores. */
  readonly root: string;
  readonly clock?: () => Date;
  /** Owner identities from wake settings and the connected app's user id, read locally. */
  readonly identity: () => Promise<{
    ownerIds: readonly string[];
    ownerEmails: readonly string[];
    appUserId: string | undefined;
  }>;
  /** Opens Clankie's connected Linear account (queries only, shared request budget). */
  readonly session: () => Promise<LinearMirrorSession>;
  /** Authenticated upload links become evidence the same way the import does. */
  readonly media?: (snapshot: LinearImportSnapshot, directory: string) => Promise<void>;
  readonly log?: (level: "info" | "warn", fields: Record<string, unknown>, message: string) => void;
}

export class LinearMirrors {
  private readonly path: string;
  private readonly queues = new Map<string, Promise<void>>();
  private registry: Promise<Registry> | undefined;
  private writing: Promise<void> = Promise.resolve();

  private readonly options: LinearMirrorsOptions;

  constructor(options: LinearMirrorsOptions) {
    this.options = options;
    this.path = join(options.root, "mirrors.json");
  }

  private now() {
    return (this.options.clock ?? (() => new Date()))().toISOString();
  }

  private async load(): Promise<Registry> {
    this.registry ??= readFile(this.path, "utf8").then(
      (text) => RegistrySchema.parse(JSON.parse(text)),
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return { schemaVersion: 1 as const, mirrors: {} };
      },
    );
    return this.registry;
  }

  private async update(scratch: string, change: (binding: Binding) => void): Promise<Binding | undefined> {
    const run = this.writing.then(async () => {
      const registry = await this.load();
      const binding = registry.mirrors[scratch];
      if (!binding) return undefined;
      change(binding);
      await mkdir(this.options.root, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      return structuredClone(binding);
    });
    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private readonly trackers = new Map<string, LocalTrackerBackend>();

  /** One backend per scratch store, so item-event subscribers see every mirrored change. */
  tracker(scratch: string): LocalTrackerBackend {
    let tracker = this.trackers.get(scratch);
    if (!tracker) {
      tracker = createLocalTracker({ directory: join(this.options.root, scratch) });
      this.trackers.set(scratch, tracker);
    }
    return tracker;
  }

  /** Owner command: enable, disable or report one scratch store's mirror. */
  async configure(scratch: string, projectId: string, action: LinearMirrorAction) {
    const registry = await this.load();
    const existing = registry.mirrors[scratch];
    if (action === "status") {
      if (!existing || existing.projectId !== projectId) return { scratch, projectId, enabled: false };
      return { ...existing, appliedEvents: await this.appliedEvents(scratch, projectId) };
    }
    if (action === "disable") {
      if (!existing || existing.projectId !== projectId) return { scratch, projectId, enabled: false };
      return this.update(scratch, (binding) => {
        binding.enabled = false;
        binding.updatedAt = this.now();
      });
    }
    try {
      await stat(join(this.options.root, scratch, "tracker.json"));
    } catch {
      throw new Error("No imported scratch store by that name; run clankie work import linear first");
    }
    const view = await this.tracker(scratch).linearMirrorView(projectId);
    if (!view?.records.projects?.some((project) => project.id === projectId))
      throw new Error("That scratch store was not imported from this Linear project");
    if (existing && existing.projectId !== projectId)
      throw new Error("That scratch store already mirrors another project");
    registry.mirrors[scratch] ??= {
      scratch,
      projectId,
      workspaceId: view.workspaceId,
      enabled: true,
      updatedAt: this.now(),
      counters: { applied: 0, duplicate: 0, ignored: 0, drift: 0, failed: 0 },
      drift: [],
    };
    return this.update(scratch, (binding) => {
      binding.enabled = true;
      binding.updatedAt = this.now();
    });
  }

  private async appliedEvents(scratch: string, projectId: string) {
    return (await this.tracker(scratch).linearMirrorView(projectId))?.appliedEvents.size ?? 0;
  }

  /**
   * Accepts one verified webhook event. Mirrors apply in order per store, after the
   * response; a failure is recorded on the mirror and never reaches the wake path.
   */
  receive(event: LinearMirrorEvent): void {
    const queued = this.load().then((registry) => {
      for (const binding of Object.values(registry.mirrors)) {
        if (!binding.enabled) continue;
        if (event.organizationId !== undefined && event.organizationId !== binding.workspaceId) continue;
        const previous = this.queues.get(binding.scratch) ?? Promise.resolve();
        const next = previous.then(() => this.apply(binding.scratch, binding.projectId, event));
        this.queues.set(
          binding.scratch,
          next.catch(() => undefined),
        );
      }
    });
    queued.catch((error) =>
      this.options.log?.("warn", { error: String(error) }, "linear mirror registry unavailable"),
    );
  }

  /** Resolves when every accepted event has been applied or recorded as failed. */
  async idle(): Promise<void> {
    await this.load().catch(() => undefined);
    for (;;) {
      const pending = [...this.queues.values()];
      await Promise.all(pending);
      if ([...this.queues.values()].every((entry, index) => entry === pending[index])) return;
    }
  }

  private async apply(scratch: string, projectId: string, event: LinearMirrorEvent): Promise<void> {
    const at = this.now();
    try {
      const tracker = this.tracker(scratch);
      const outcome = await this.applyOnce(tracker, scratch, projectId, event);
      if (outcome.kind === "drift") {
        await this.repair(tracker, scratch, projectId, event, outcome.drift);
        return;
      }
      await this.update(scratch, (binding) => {
        binding.lastEventAt = at;
        if (outcome.kind === "applied") binding.counters.applied++;
        else if (outcome.kind === "duplicate") binding.counters.duplicate++;
        else binding.counters.ignored++;
      });
      this.options.log?.(
        "info",
        { event: "linear.mirror", scratch, eventId: event.eventId, type: event.type, outcome: outcome.kind },
        "linear mirror event",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.update(scratch, (binding) => {
        binding.counters.failed++;
        binding.lastError = message.slice(0, 500);
        binding.lastEventAt = at;
      });
      this.options.log?.("warn", { scratch, eventId: event.eventId, error: message }, "linear mirror failed");
    }
  }

  private async actorMap(records: readonly LinearRecord[]): Promise<Record<string, TrackerActor>> {
    return linearActorMap(records, await this.options.identity());
  }

  private async applyOnce(
    tracker: LocalTrackerBackend,
    scratch: string,
    projectId: string,
    event: LinearMirrorEvent,
  ): Promise<
    | { kind: "applied" | "duplicate" | "ignored"; reason?: string }
    | { kind: "drift"; drift: LinearMirrorDrift }
  > {
    const view = await tracker.linearMirrorView(projectId);
    if (!view) throw new Error("Mirror store has no imported Linear records");
    const plan = planLinearMirrorEvent(event, view);
    if (plan.kind === "duplicate") return { kind: "duplicate" };
    if (plan.kind === "irrelevant") return { kind: "ignored", reason: plan.reason };
    if (plan.kind === "drift") return { kind: "drift", drift: plan.drift };
    const directory = join(this.options.root, scratch);
    if (this.options.media) {
      const project = view.records.projects?.find((record) => record.id === projectId);
      await this.options.media(
        {
          ...plan.snapshot,
          projects: plan.snapshot.projects.length ? plan.snapshot.projects : project ? [project] : [],
        },
        directory,
      );
    }
    const actorMap = await this.actorMap([...(view.records.actors ?? []), ...plan.snapshot.actors]);
    const eventActorId = typeof event.actor?.id === "string" ? event.actor.id : undefined;
    const actor: TrackerActor = (eventActorId && actorMap[eventActorId]) || {
      type: "app",
      id: eventActorId ? `linear:${eventActorId}` : "linear",
      name: event.actor?.name ?? "Linear",
      onBehalfOf: [],
    };
    const report = await tracker.importLinear(plan.snapshot, actorMap, {
      actor: { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] },
      mirrorEvent: {
        eventId: event.eventId,
        deliveryId: event.deliveryId,
        type: event.type,
        action: event.action,
        actor,
        removed: plan.removed,
      },
    });
    if (report.duplicate) return { kind: "duplicate" };
    if (plan.refresh) await this.reimport(tracker, scratch, projectId, plan.refresh);
    return { kind: "applied" };
  }

  /** Scoped re-import through the connected account, with the import's own mapper. */
  private async reimport(
    tracker: LocalTrackerBackend,
    scratch: string,
    projectId: string,
    drift: LinearMirrorDrift,
  ) {
    const session = await this.options.session();
    const { snapshot, outside } = await collectLinearScoped({
      projectId,
      query: session.query,
      issueIds: drift.issueIds.slice(0, DRIFT_MAX_ISSUES),
      milestones: drift.milestones,
      labels: drift.labels,
      statusUpdates: drift.statusUpdates,
    });
    if (snapshot.workspaceId !== session.binding.workspaceId)
      throw new Error("Linear workspace did not match connected account");
    await this.options.media?.(snapshot, join(this.options.root, scratch));
    const view = await tracker.linearMirrorView(projectId);
    const actorMap = await this.actorMap([...(view?.records.actors ?? []), ...snapshot.actors]);
    await tracker.importLinear(snapshot, actorMap, {
      actor: { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] },
      beforeWrite: async () => {
        await session.access();
      },
    });
    return { outside, requests: session.requests() };
  }

  private async repair(
    tracker: LocalTrackerBackend,
    scratch: string,
    projectId: string,
    event: LinearMirrorEvent,
    drift: LinearMirrorDrift,
  ) {
    const at = this.now();
    let report: LinearMirrorDriftReport = {
      at,
      eventId: event.eventId,
      type: event.type,
      action: event.action,
      references: drift.references,
      outcome: "failed",
      requests: 0,
    };
    try {
      const { outside, requests } = await this.reimport(tracker, scratch, projectId, drift);
      const again = await this.applyOnce(tracker, scratch, projectId, event);
      report = {
        ...report,
        requests,
        ...(outside.length ? { outside } : {}),
        outcome: again.kind === "drift" ? "unresolved" : "repaired",
      };
    } catch (error) {
      report = { ...report, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
    await this.update(scratch, (binding) => {
      binding.counters.drift++;
      if (report.outcome === "failed") binding.counters.failed++;
      binding.lastEventAt = at;
      binding.drift = [...binding.drift, report].slice(-DRIFT_RETAINED);
    });
    this.options.log?.(
      "warn",
      { event: "linear.mirror.drift", scratch, ...report },
      "linear mirror drift reported",
    );
  }
}

/** The signed activity the webhook route accepted, as the mirror reads it. */
export function linearMirrorEvent(activity: {
  eventId?: string | undefined;
  deliveryId?: string | undefined;
  type: string;
  action: string;
  organizationId?: string | undefined;
  createdAt?: string | undefined;
  actorId?: string | undefined;
  actorName?: string | undefined;
  actorEmail?: string | undefined;
  actorType?: string | undefined;
  data: Record<string, unknown>;
  updatedFrom?: Record<string, unknown> | undefined;
  projectId?: string | undefined;
}): LinearMirrorEvent | undefined {
  if (!activity.eventId) return undefined;
  return {
    eventId: activity.eventId,
    deliveryId: activity.deliveryId,
    type: activity.type,
    action: activity.action,
    organizationId: activity.organizationId,
    createdAt: activity.createdAt,
    actor: {
      id: activity.actorId ?? null,
      name: activity.actorName ?? null,
      email: activity.actorEmail ?? null,
      type: activity.actorType ?? null,
    },
    data: activity.data,
    updatedFrom: activity.updatedFrom,
    projectId: activity.projectId,
  };
}
