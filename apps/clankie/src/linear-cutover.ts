import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SettingsStore } from "@clankie/settings";
import { projectsRevision, updateProjectSettings } from "@clankie/settings";
import { WorkConventionSchema, type WorkConvention } from "@clankie/protocol/work-items";
import {
  promoteLinearImport,
  readTrackerStoreSummary,
  restoreTrackerStore,
  TRACKER_OWNER,
  type LinearImportSnapshot,
  type TrackerStoreSummary,
} from "@clankie/work-items";
import { z } from "zod";
import type { LinearMirrors } from "./linear-mirror.ts";

/**
 * Mirror 3 (VUH-1987): the owner cuts one World project over from Linear to the
 * built-in tracker, and can switch back. The imported, mirrored scratch store
 * becomes the live store; the project binds to the imported tracker project UUID;
 * its `.clankie/tracking.json` switches from `linear` to `builtin`. Every step is
 * printed by `--dry-run` first, and refuses when the copy has drifted from Linear.
 * Linear is only read, never written.
 */

const CONVENTION_FILE = join(".clankie", "tracking.json");

export const CutoverRequestSchema = z
  .object({
    worldProject: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    scratch: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/u)
      .optional(),
    linearProjectId: z.string().uuid().optional(),
    switchBack: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  })
  .strict()
  .refine((request) => request.switchBack || (request.scratch && request.linearProjectId), {
    message: "A cutover names its scratch import and Linear project",
  });
type CutoverRequest = z.infer<typeof CutoverRequestSchema>;

/** The durable record of an applied cutover; switch-back restores exactly this. */
const ActiveCutoverSchema = z.object({
  schemaVersion: z.literal(1),
  at: z.string(),
  directory: z.string(),
  worldProject: z.string(),
  scratch: z.string(),
  linearProjectId: z.string(),
  conventionPath: z.string(),
  previousConvention: z.string(),
  previousTrackerProjectId: z.string().optional(),
  storeBackup: z.string().optional(),
  previousStoreId: z.string().optional(),
  storeId: z.string().optional(),
  mirrorWasEnabled: z.boolean(),
  steps: z.array(z.enum(["mirror", "store", "setting", "convention"])),
});
type ActiveCutover = z.infer<typeof ActiveCutoverSchema>;

interface LinearCutoverOptions {
  /** The live built-in tracker directory (`<state>/tracker`). */
  readonly trackerDirectory: string;
  /** Scratch imports (`<state>/tracker-imports`). */
  readonly importsRoot: string;
  readonly mirrors: Pick<LinearMirrors, "configure">;
  readonly settings: Pick<SettingsStore, "load" | "update">;
  /** A read-only capture of the Linear project through the connected account. */
  readonly linearSnapshot: (
    projectId: string,
  ) => Promise<{ snapshot: LinearImportSnapshot; requests: number }>;
  readonly localMachineId?: string;
  readonly clock?: () => Date;
}

const SNAPSHOT_TYPES = [
  "projects",
  "issues",
  "comments",
  "relations",
  "labels",
  "milestones",
  "documents",
  "statusUpdates",
  "cycles",
  "actors",
] as const;

interface TypeCount {
  linear: number;
  builtIn: number;
  /** In Linear, not in the copy. */
  missing: number;
  /** In the copy, no longer in Linear (removed there; the copy keeps it as history). */
  extra: number;
  /** In both, but Linear's updatedAt is newer or different. */
  stale: number;
}

/** Linear's records against the copy's provider records, by id and Linear's own updatedAt. */
function compareCounts(snapshot: LinearImportSnapshot, copy: TrackerStoreSummary | undefined) {
  const counts: Record<string, TypeCount> = {};
  for (const type of SNAPSHOT_TYPES) {
    const linear = snapshot[type];
    const local = new Map((copy?.mirror?.records[type] ?? []).map((record) => [record.id, record]));
    const seen = new Set<string>();
    let missing = 0;
    let stale = 0;
    for (const record of linear) {
      seen.add(record.id);
      const held = local.get(record.id);
      if (!held) missing++;
      else if (typeof record.updatedAt === "string" && held.updatedAt !== record.updatedAt) stale++;
    }
    counts[type] = {
      linear: linear.length,
      builtIn: local.size,
      missing,
      extra: [...local.keys()].filter((id) => !seen.has(id)).length,
      stale,
    };
  }
  return counts;
}

export class LinearCutover {
  private readonly options: LinearCutoverOptions;
  private running: Promise<unknown> = Promise.resolve();

  constructor(options: LinearCutoverOptions) {
    this.options = options;
  }

  private now() {
    return (this.options.clock ?? (() => new Date()))().toISOString();
  }

  private get directory() {
    return join(this.options.trackerDirectory, "cutover");
  }

  private get activePath() {
    return join(this.directory, "active.json");
  }

  private async active(): Promise<ActiveCutover | undefined> {
    try {
      return ActiveCutoverSchema.parse(JSON.parse(await readFile(this.activePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async saveActive(record: ActiveCutover) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.activePath}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.activePath);
  }

  /** The World project, its one local workspace and the convention file its trackerRef names. */
  private async worldProject(id: string) {
    const settings = await this.options.settings.load();
    const project = settings.projects.projects.find((entry) => entry.id === id);
    if (!project) throw new Error(`No World project ${id}`);
    const machine = this.options.localMachineId ?? "local";
    const workspace = project.trackerRef
      ? project.workspaces.find((entry) => entry.id === project.trackerRef!.workspaceId)
      : undefined;
    if (!workspace || workspace.machineId !== machine)
      throw new Error(`World project ${id} has no tracker convention in a workspace on this machine`);
    if (project.trackerRef!.path !== ".clankie/tracking.json")
      throw new Error(`World project ${id} names an unexpected tracker file`);
    return {
      settings,
      project,
      conventionPath: join(resolve(workspace.path), CONVENTION_FILE),
    };
  }

  /** One at a time per service: the steps read and replace the same files. */
  run(request: CutoverRequest): Promise<unknown> {
    const step = (): Promise<unknown> =>
      request.switchBack ? this.switchBack(request) : this.cutover(request);
    const next = this.running.then(step, step);
    this.running = next.catch(() => undefined);
    return next;
  }

  private async cutover(request: CutoverRequest) {
    const scratch = request.scratch!;
    const linearProjectId = request.linearProjectId!;
    const refusals: string[] = [];
    const warnings: string[] = [];
    const { settings, project, conventionPath } = await this.worldProject(request.worldProject);
    const conventionText = await readFile(conventionPath, "utf8").catch(() => undefined);
    let convention: WorkConvention | undefined;
    try {
      convention =
        conventionText === undefined ? undefined : WorkConventionSchema.parse(JSON.parse(conventionText));
    } catch {
      refusals.push(`${conventionPath} is not a valid tracker convention`);
    }
    if (conventionText === undefined) refusals.push(`${conventionPath} does not exist`);
    else if (convention && convention.backend !== "linear")
      refusals.push(`The convention is ${convention.backend}, not linear; nothing to cut over`);
    const active = await this.active();
    if (active) refusals.push(`A cutover of ${active.worldProject} is already active; switch it back first`);

    const scratchDirectory = join(this.options.importsRoot, scratch);
    const copy = await readTrackerStoreSummary(scratchDirectory);
    if (!copy.exists) refusals.push(`No scratch import ${scratch}; run clankie work import linear first`);
    else if (!copy.mirror) refusals.push(`Scratch store ${scratch} is not a Linear import`);
    else if (copy.mirror.cutover) refusals.push(`Scratch store ${scratch} was already cut over`);
    const importedProject = copy.mirror?.projects.find((entry) => entry.id === linearProjectId);
    if (copy.mirror && !importedProject)
      refusals.push(`Scratch store ${scratch} was not imported from Linear project ${linearProjectId}`);
    if (
      importedProject &&
      convention?.linear?.project !== undefined &&
      convention.linear.project.toLowerCase() !== importedProject.name.toLowerCase()
    )
      refusals.push(
        `The convention scopes Linear project "${convention.linear.project}", but the import is "${importedProject.name}"`,
      );
    if (copy.localWrites > 0)
      refusals.push(
        `Scratch store ${scratch} holds ${copy.localWrites} writes that did not come from Linear`,
      );

    const live = await readTrackerStoreSummary(this.options.trackerDirectory);
    if (!live.empty)
      refusals.push(
        "The live built-in tracker already holds records; cutover replaces only an empty store (no merge)",
      );
    const bound = settings.projects.projects.find(
      (entry) => entry.trackerProjectId === linearProjectId && entry.id !== project.id,
    );
    if (bound) refusals.push(`Tracker project ${linearProjectId} is already bound to ${bound.id}`);

    // The mirror's own record: anything it could not apply or repair is drift.
    const mirror = (await this.options.mirrors.configure(scratch, linearProjectId, "status")) as Record<
      string,
      unknown
    >;
    const counters = (mirror.counters ?? {}) as Record<string, number>;
    const unresolved = ((mirror.drift ?? []) as { outcome: string }[]).filter(
      (report) => report.outcome !== "repaired",
    ).length;
    const mirrorEnabled = mirror.enabled === true;
    if (mirror.counters === undefined)
      warnings.push(
        `The webhook mirror was never enabled for ${scratch}; only the fresh Linear read checks drift`,
      );
    if ((counters.failed ?? 0) > 0) refusals.push(`The mirror recorded ${counters.failed} failed events`);
    if (unresolved > 0) refusals.push(`The mirror holds ${unresolved} unrepaired drift reports`);

    // A fresh read-only capture of the Linear project: the copy must hold exactly it.
    let counts: Record<string, TypeCount> | undefined;
    let linearRequests: number | undefined;
    try {
      const read = await this.options.linearSnapshot(linearProjectId);
      linearRequests = read.requests;
      if (copy.mirror && read.snapshot.workspaceId !== copy.mirror.workspaceId)
        refusals.push("The import came from another Linear workspace");
      counts = compareCounts(read.snapshot, copy.exists ? copy : undefined);
      const drifted = Object.entries(counts).filter(
        ([type, count]) => count.missing > 0 || (type !== "actors" && count.stale > 0),
      );
      if (drifted.length)
        refusals.push(
          `The copy has drifted from Linear (${drifted
            .map(([type, count]) => `${type}: ${count.missing} missing, ${count.stale} stale`)
            .join("; ")}); rerun clankie work import linear, then retry`,
        );
      for (const [type, count] of Object.entries(counts))
        if (count.extra > 0)
          warnings.push(`${count.extra} ${type} are kept in the copy but no longer in Linear`);
    } catch (error) {
      refusals.push(`Linear could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }

    const at = this.now();
    const stamp = at.replace(/[:.]/gu, "-");
    const directory = join(this.directory, stamp);
    const next =
      convention === undefined
        ? undefined
        : WorkConventionSchema.parse({
            ...convention,
            backend: "builtin",
            decidedBy: "owner",
            decidedAt: at,
            note: `Cut over from Linear project ${linearProjectId} (scratch ${scratch}) on ${at}; switch back with clankie work cutover linear --world-project ${project.id} --switch-back.`,
          });
    const switchBack = `clankie work cutover linear --world-project ${project.id} --switch-back`;
    const plan = {
      action: "cutover" as const,
      dryRun: request.dryRun,
      ready: refusals.length === 0,
      refusals,
      warnings,
      worldProject: { id: project.id, name: project.name, conventionPath },
      linearProjectId,
      scratch,
      trackerProjectId: linearProjectId,
      ...(linearRequests === undefined ? {} : { linearRequests }),
      ...(counts === undefined ? {} : { counts }),
      mirror: {
        enabled: mirrorEnabled,
        ...(mirror.counters === undefined ? {} : { counters }),
        unresolvedDrift: unresolved,
        ...(typeof mirror.lastEventAt === "string" ? { lastEventAt: mirror.lastEventAt } : {}),
        ...(typeof mirror.lastError === "string" ? { lastError: mirror.lastError } : {}),
      },
      changes: [
        {
          what: "mirror",
          scratch,
          from: mirror.counters === undefined ? "never enabled" : mirrorEnabled ? "enabled" : "disabled",
          to: "disabled",
        },
        {
          what: "store",
          path: join(resolve(this.options.trackerDirectory), "tracker.json"),
          from: { storeId: live.storeId ?? null, empty: live.empty, counts: live.counts },
          to: {
            source: join(resolve(scratchDirectory), "tracker.json"),
            storeId: copy.storeId ?? null,
            counts: copy.counts,
            writable: true,
          },
          backup: join(directory, "before.json"),
        },
        {
          what: "setting",
          worldProject: project.id,
          field: "trackerProjectId",
          from: project.trackerProjectId ?? null,
          to: linearProjectId,
        },
        {
          what: "file",
          path: conventionPath,
          from: convention ?? null,
          to: next ?? null,
          backup: join(directory, "tracking.json"),
        },
      ],
      record: this.activePath,
      switchBack,
    };
    if (request.dryRun || refusals.length) return plan;

    // Intent first, so a partial failure still switches back from what was done.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "tracking.json"), conventionText!, { mode: 0o600, flag: "wx" });
    const record: ActiveCutover = {
      schemaVersion: 1,
      at,
      directory,
      worldProject: project.id,
      scratch,
      linearProjectId,
      conventionPath,
      previousConvention: join(directory, "tracking.json"),
      ...(project.trackerProjectId === undefined
        ? {}
        : { previousTrackerProjectId: project.trackerProjectId }),
      mirrorWasEnabled: mirrorEnabled,
      steps: [],
    };
    await this.saveActive(record);
    if (mirror.counters !== undefined) {
      await this.options.mirrors.configure(scratch, linearProjectId, "disable");
      record.steps.push("mirror");
      await this.saveActive(record);
    }
    const promoted = await promoteLinearImport({
      source: scratchDirectory,
      target: this.options.trackerDirectory,
      backup: join(directory, "before.json"),
      linearProjectId,
      scratch,
      actor: { ...TRACKER_OWNER, onBehalfOf: [] },
      ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
      verify: (source, target) => {
        if (!target.empty) throw new Error("The live built-in tracker gained records; cutover stopped");
        if (source.storeId !== copy.storeId || source.localWrites > 0)
          throw new Error("The scratch import changed since the plan; cutover stopped");
      },
    });
    record.steps.push("store");
    record.storeId = promoted.storeId;
    if (promoted.previousStoreId !== undefined) record.previousStoreId = promoted.previousStoreId;
    if (promoted.backedUp) record.storeBackup = join(directory, "before.json");
    await this.saveActive(record);
    await this.bind(project.id, linearProjectId);
    record.steps.push("setting");
    await this.saveActive(record);
    await this.writeConvention(conventionPath, `${JSON.stringify(next, null, 2)}\n`, conventionText!);
    record.steps.push("convention");
    await this.saveActive(record);
    return { ...plan, applied: record.steps, storeId: promoted.storeId };
  }

  private async bind(projectId: string, trackerProjectId: string | null) {
    await this.options.settings.update((current) => ({
      ...current,
      projects: updateProjectSettings(current.projects, {
        projectId,
        expectedRevision: projectsRevision(current.projects),
        changes: { trackerProjectId },
      }),
    }));
  }

  /** Replaces the convention only if nobody changed it since it was read. */
  private async writeConvention(path: string, content: string, expected: string) {
    if ((await readFile(path, "utf8")) !== expected) throw new Error(`${path} changed; stopped`);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, { flag: "wx" });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }

  private async switchBack(request: CutoverRequest) {
    const active = await this.active();
    const refusals: string[] = [];
    if (!active) refusals.push("No cutover is active");
    else if (active.worldProject !== request.worldProject)
      refusals.push(`The active cutover is ${active.worldProject}, not ${request.worldProject}`);
    const { project, conventionPath } = await this.worldProject(request.worldProject);
    const live = await readTrackerStoreSummary(this.options.trackerDirectory);
    const currentConvention = await readFile(conventionPath, "utf8").catch(() => undefined);
    const previousConvention = active ? await readFile(active.previousConvention, "utf8") : undefined;
    if (active?.steps.includes("store") && live.storeId !== active.storeId)
      refusals.push("The live store is not the one this cutover promoted; restore it by hand");
    const at = this.now();
    const keep = active ? join(active.directory, `pilot-${at.replace(/[:.]/gu, "-")}.json`) : undefined;
    const plan = {
      action: "switch-back" as const,
      dryRun: request.dryRun,
      ready: refusals.length === 0,
      refusals,
      worldProject: { id: project.id, name: project.name, conventionPath },
      ...(active
        ? {
            cutover: { at: active.at, scratch: active.scratch, linearProjectId: active.linearProjectId },
            /** Built-in writes since the cutover: Linear never saw them; port them by hand. */
            pilotWrites: live.localWrites,
            changes: [
              ...(active.steps.includes("convention")
                ? [
                    {
                      what: "file",
                      path: conventionPath,
                      from: currentConvention === undefined ? null : JSON.parse(currentConvention),
                      to: previousConvention === undefined ? null : JSON.parse(previousConvention),
                    },
                  ]
                : []),
              ...(active.steps.includes("setting")
                ? [
                    {
                      what: "setting",
                      worldProject: project.id,
                      field: "trackerProjectId",
                      from: project.trackerProjectId ?? null,
                      to: active.previousTrackerProjectId ?? null,
                    },
                  ]
                : []),
              ...(active.steps.includes("store")
                ? [
                    {
                      what: "store",
                      path: join(resolve(this.options.trackerDirectory), "tracker.json"),
                      from: { storeId: live.storeId ?? null, counts: live.counts },
                      to: {
                        storeId: active.previousStoreId ?? null,
                        restoredFrom: active.storeBackup ?? null,
                      },
                      keep,
                    },
                  ]
                : []),
            ],
            afterwards: `The webhook mirror stays disabled. To cut over again: clankie work import linear --project ${active.linearProjectId} --scratch NEW_NAME, then clankie work cutover linear --world-project ${project.id} --scratch NEW_NAME --project ${active.linearProjectId}.`,
          }
        : {}),
    };
    if (request.dryRun || refusals.length || !active) return plan;
    if (active.steps.includes("convention"))
      await this.writeConvention(conventionPath, previousConvention!, currentConvention ?? "");
    if (active.steps.includes("setting"))
      await this.bind(project.id, active.previousTrackerProjectId ?? null);
    if (active.steps.includes("store"))
      await restoreTrackerStore({
        target: this.options.trackerDirectory,
        backup: active.storeBackup,
        keep: keep!,
        verify: (current) => {
          if (current.storeId !== active.storeId) throw new Error("The live store changed; stopped");
        },
      });
    await rename(this.activePath, join(active.directory, "switched-back.json"));
    return { ...plan, applied: true };
  }
}
