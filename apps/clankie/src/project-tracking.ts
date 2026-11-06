import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { effectiveFleetAutonomy } from "@clankie/protocol";
import type { Project } from "@clankie/protocol/projects";
import {
  ApplyProjectTrackingSchema,
  PROJECT_TRACKING_APPLY_PATH,
  PROJECT_TRACKING_PATH,
  TrackerChoiceSchema,
  TrackingRepoSchema,
  type ProjectTrackingSuggestion,
  type ProjectTrackingView,
  type TrackingRepoStatus,
} from "@clankie/protocol/project-tracking";
import { projectsRevision, type ClankieSettings } from "@clankie/settings";
import {
  inspectTrackingRepo,
  proposeTrackingRepo,
  TRACKING_BRANCH,
  withdrawDepartedRepo,
  type GithubApi,
} from "@clankie/work-items";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface TrackingLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

const proposalName = (status: TrackingRepoStatus) =>
  status.pull ? `its proposal #${String(status.pull.number)}` : `its ${TRACKING_BRANCH} branch`;

/** The text never carries the board itself: an alert can travel further than the setting does. */
function exposureAlert(projectId: string, status: TrackingRepoStatus): string {
  const published = status.reason?.startsWith("private_board_published") === true;
  const exposed = status.reason?.includes("private_board_exposed") === true;
  const where = !published
    ? `${proposalName(status)} still names`
    : exposed
      ? `its default branch and ${proposalName(status)} still name`
      : "its default branch still names";
  return `${status.repo} is no longer confirmed private, and ${where} the private board. Clankie left it in place. \`clankie project tracking ${projectId} apply\` withdraws or replaces it; the repo's merged history is yours to manage.`;
}

function departedAlert(projectId: string, status: TrackingRepoStatus): string {
  const left = `${status.repo} left project ${projectId}'s tracking setting`;
  if (!status.reason?.includes("private_board_exposed"))
    return `${left}, it is no longer confirmed private, and its default branch still names the private board. No pass watches this repo now, and its merged history is yours to manage.`;
  const where = status.reason.startsWith("private_board_published")
    ? `its default branch and ${proposalName(status)} still name`
    : `${proposalName(status)} still names`;
  return `${left}, and ${where} the private board. Clankie has not withdrawn it, and no pass watches this repo now: close the pull request and delete the ${TRACKING_BRANCH} branch.`;
}

/** A repo a pass has reached, so the proposal it may hold is found again once it leaves the setting. */
const TrackedRepoSchema = z
  .object({ repo: TrackingRepoSchema, projectId: z.string(), tracker: TrackerChoiceSchema })
  .strict();
type TrackedRepo = z.infer<typeof TrackedRepoSchema>;

/** Where tracked repos outlive a restart. Without one they last as long as the service. */
export interface TrackedRepoStore {
  load(): Promise<readonly TrackedRepo[]>;
  save(repos: readonly TrackedRepo[]): Promise<void>;
}

/** Owner-only, because each entry holds the private board. */
export function trackedRepoFile(path: string): TrackedRepoStore {
  return {
    async load() {
      const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "[]";
        throw error;
      });
      return z.array(TrackedRepoSchema).parse(JSON.parse(text));
    },
    async save(repos) {
      const pending = `${path}.${randomUUID()}.pending`;
      try {
        await writeFile(pending, JSON.stringify(repos), { mode: 0o600 });
        await rename(pending, path);
      } finally {
        await rm(pending, { force: true });
      }
    },
  };
}

/**
 * What a pass's writes rest on, renewed before each one by the forge (work-items' authorizeWrite):
 * the owner's own apply, or for a sweep the setting and `push: lead` that called for the write.
 */
export interface TrackingWriteAuthority {
  authorize(): Promise<boolean>;
  current(): boolean;
}
/** A read: nothing it reaches may write. */
const READ_ONLY: TrackingWriteAuthority = { authorize: async () => false, current: () => false };

const pushes = (settings: ClankieSettings, project: Project | undefined) =>
  effectiveFleetAutonomy(settings.autonomy, project?.autonomy).push === "lead";

/** Deterministic end to end: settings in, a template out, one small proposal per repo. */
export function createProjectTrackingService(options: {
  readonly settings: { load(): Promise<ClankieSettings> };
  /**
   * The forge the proposals go through, resolved for each pass so a reconnect takes effect. It
   * pins the account it resolved and refuses a write once that account or `authority` changes.
   */
  readonly forge: (authority: TrackingWriteAuthority) => Promise<GithubApi>;
  readonly suggest?: (project: Project) => Promise<ProjectTrackingSuggestion | undefined>;
  readonly logger?: TrackingLogger;
  /** Reaches the owner; false means it did not, and the next sweep tries again. */
  readonly alert?: (text: string) => Promise<boolean>;
  readonly trackedRepos?: TrackedRepoStore;
}) {
  const alerted = new Set<string>();
  /**
   * Once per exposure, which the text says exactly: a reason also carries whichever call failed
   * this pass. True when the owner has heard, or when no alert is wired to tell them.
   */
  const alertExposure = async (projectId: string, repo: string, text: string) => {
    if (alerted.has(text)) return true;
    const delivered = await options.alert?.(text).catch((error: unknown) => {
      options.logger?.warn(
        { event: "project_tracking.alert_failed", projectId, repo, error: String(error) },
        "Could not alert the owner about a private board",
      );
      return false;
    });
    if (delivered) alerted.add(text);
    return delivered ?? true;
  };
  // Changed in memory and saved in order, so an apply beside a sweep can't lose an entry. A file
  // that won't load stays as it is: nothing is saved over it, and every pass logs why and tries
  // it again, so a hand fix needs no restart.
  let loaded: Promise<Map<string, TrackedRepo>> | undefined;
  const trackedRepos = () =>
    (loaded ??= Promise.resolve(options.trackedRepos?.load() ?? [])
      .then((repos) => new Map(repos.map((tracked) => [tracked.repo.toLowerCase(), tracked])))
      .catch((error: unknown) => {
        loaded = undefined;
        throw error;
      }));
  let saving = Promise.resolve();
  const saveTrackedRepos = (tracked: Map<string, TrackedRepo>) => {
    const save = () => options.trackedRepos?.save([...tracked.values()]);
    saving = saving.then(save, save);
    return saving;
  };
  /** Before any write, so a proposal normally has this record of where it went. */
  const rememberRepos = async (project: Project) => {
    if (!project.tracking) return;
    try {
      const tracked = await trackedRepos();
      for (const repo of project.tracking.repos)
        tracked.set(repo.toLowerCase(), { repo, projectId: project.id, tracker: project.tracking.tracker });
      await saveTrackedRepos(tracked);
    } catch (error) {
      options.logger?.warn(
        { event: "project_tracking.remember_failed", projectId: project.id, error: String(error) },
        "Could not record a project's tracked repos",
      );
    }
  };
  /** A repo no project claims keeps its entry until its proposal is gone and the owner has heard. */
  const settleDepartedRepos = async (current: ClankieSettings) => {
    const tracked = await trackedRepos();
    const claimed = new Set(
      current.projects.projects.flatMap((project) =>
        (project.tracking?.repos ?? []).map((repo) => repo.toLowerCase()),
      ),
    );
    const departed = [...tracked].filter(([key]) => !claimed.has(key));
    for (const [key, { repo, projectId, tracker }] of departed) {
      const projectOf = (settings: ClankieSettings) =>
        settings.projects.projects.find((candidate) => candidate.id === projectId);
      const withdraw = pushes(current, projectOf(current));
      // Still unclaimed, and still the push preference that said to withdraw.
      const authority: TrackingWriteAuthority = {
        current: () => true,
        authorize: async () => {
          const now = await options.settings.load();
          return (
            pushes(now, projectOf(now)) &&
            !now.projects.projects.some((project) =>
              project.tracking?.repos.some((claimed) => claimed.toLowerCase() === key),
            )
          );
        },
      };
      const status = await withdrawDepartedRepo(await options.forge(authority), repo, tracker, {
        withdraw,
      });
      const exposed = status?.reason?.includes("private_board_exposed") === true;
      const heard =
        status && (exposed || status.reason?.startsWith("private_board_published"))
          ? await alertExposure(projectId, repo, departedAlert(projectId, status))
          : true;
      if (status?.state === "unavailable")
        options.logger?.warn(
          { event: "project_tracking.departed_unavailable", projectId, status },
          "Could not check a repo that left the tracking setting",
        );
      else if (heard && !exposed) {
        tracked.delete(key);
        await saveTrackedRepos(tracked);
        if (status?.reason?.endsWith("repo_left_the_setting"))
          options.logger?.info(
            { event: "project_tracking.departed_withdrawn", projectId, status },
            "Withdrew a proposal from a repo that left the tracking setting",
          );
      }
    }
  };
  // A suggestion is a convenience: failing to read one never blocks a view or a sweep.
  const suggestionFor = async (project: Project) => {
    try {
      return await options.suggest?.(project);
    } catch (error) {
      options.logger?.warn(
        { event: "project_tracking.suggest_failed", projectId: project.id, error: String(error) },
        "Could not read a project's tracking signals",
      );
      return undefined;
    }
  };
  const forEachRepo = async (
    projects: readonly Project[],
    project: Project,
    authority: TrackingWriteAuthority,
    visit: (api: GithubApi, repo: string, sharedWith: string | undefined) => Promise<TrackingRepoStatus>,
  ): Promise<TrackingRepoStatus[]> => {
    const repos = project.tracking?.repos ?? [];
    if (repos.length === 0) return [];
    let api: GithubApi;
    try {
      api = await options.forge(authority);
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 400);
      return repos.map((repo) => ({ repo, state: "unavailable", reason }));
    }
    const statuses: TrackingRepoStatus[] = [];
    for (const repo of repos) {
      const other = projects.find(
        (candidate) =>
          candidate.id !== project.id &&
          candidate.tracking?.repos.some((claimed) => claimed.toLowerCase() === repo.toLowerCase()),
      );
      statuses.push(await visit(api, repo, other?.id));
    }
    return statuses;
  };
  return {
    /** Read-only. For a repo whose proposal merged, this is the read-back. */
    async view(projectId: string): Promise<ProjectTrackingView | undefined> {
      const current = await options.settings.load();
      const project = current.projects.projects.find((saved) => saved.id === projectId);
      if (!project) return undefined;
      const tracker = project.tracking?.tracker;
      const suggestion = await suggestionFor(project);
      return {
        projectId,
        revision: projectsRevision(current.projects),
        ...(project.tracking ? { tracking: project.tracking } : {}),
        repos: await forEachRepo(current.projects.projects, project, READ_ONLY, (api, repo, sharedWith) =>
          inspectTrackingRepo(api, repo, tracker!, sharedWith === undefined ? {} : { sharedWith }),
        ),
        ...(suggestion ? { suggestion } : {}),
      };
    },
    /**
     * The owner's own apply, bound to the revision they reviewed. It reopens a declined proposal.
     * Each write renews `owner` and finds the settings still at that revision.
     */
    async apply(projectId: string, expectedRevision: string, owner: TrackingWriteAuthority) {
      const current = await options.settings.load();
      if (projectsRevision(current.projects) !== expectedRevision) return "stale_revision" as const;
      const project = current.projects.projects.find((saved) => saved.id === projectId);
      if (!project) return "unknown_project" as const;
      const tracker = project.tracking?.tracker;
      if (!tracker) return "no_tracking" as const;
      await rememberRepos(project);
      const authority: TrackingWriteAuthority = {
        current: () => owner.current(),
        authorize: async () =>
          (await owner.authorize()) &&
          projectsRevision((await options.settings.load()).projects) === expectedRevision,
      };
      return forEachRepo(current.projects.projects, project, authority, (api, repo, sharedWith) =>
        proposeTrackingRepo(api, repo, tracker, {
          reopenDeclined: true,
          ...(sharedWith === undefined ? {} : { sharedWith }),
        }),
      );
    },
    /**
     * Every project with a setting, unattended. Under `push: owner` it only reads, because
     * nobody at the keyboard said to push: the owner sees the drift and applies it themselves,
     * and a private board left in the open reaches them as an alert. A repo that left the
     * setting gets the same treatment first, and no failure there stops the rest of the pass.
     */
    async sweep(): Promise<void> {
      const current = await options.settings.load();
      await settleDepartedRepos(current).catch((error: unknown) => {
        options.logger?.warn(
          { event: "project_tracking.departed_failed", error: String(error) },
          "Could not check the repos that left the tracking setting",
        );
      });
      for (const project of current.projects.projects) {
        const tracker = project.tracking?.tracker;
        if (!tracker) continue;
        await rememberRepos(project);
        const proposes = pushes(current, project);
        // Nobody at the keyboard: the writes rest on this same setting still saying to push.
        const setting = JSON.stringify(project.tracking);
        const authority: TrackingWriteAuthority = {
          current: () => true,
          authorize: async () => {
            const now = await options.settings.load();
            const still = now.projects.projects.find((candidate) => candidate.id === project.id);
            return JSON.stringify(still?.tracking) === setting && pushes(now, still);
          },
        };
        const statuses = await forEachRepo(
          current.projects.projects,
          project,
          authority,
          (api, repo, sharedWith) => {
            const repoOptions = sharedWith === undefined ? {} : { sharedWith };
            return proposes
              ? proposeTrackingRepo(api, repo, tracker, repoOptions)
              : inspectTrackingRepo(api, repo, tracker, repoOptions);
          },
        );
        for (const status of statuses)
          if (status.reason?.startsWith("private_board_"))
            await alertExposure(project.id, status.repo, exposureAlert(project.id, status));
        const unsettled = statuses.filter(
          (status) =>
            status.state !== "in_step" || status.withdrawnPull !== undefined || status.reason !== undefined,
        );
        const suggestion = await suggestionFor(project);
        const fields = {
          event: "project_tracking.sweep",
          projectId: project.id,
          proposes,
          unsettled,
          ...(suggestion?.movedFromSetting ? { suggestion } : {}),
        };
        if (unsettled.length > 0 || suggestion?.movedFromSetting)
          options.logger?.warn(fields, "A project's tracking blocks or signals need attention");
        else options.logger?.info(fields, "Project tracking blocks are in step");
      }
    },
  };
}
export type ProjectTrackingService = ReturnType<typeof createProjectTrackingService>;

/**
 * One pass at start, so a restart doesn't put the next one a full interval off, then one a tick.
 * One pass at a time; a failed pass waits for the next tick, and a stop leaves no timer.
 */
export function startProjectTrackingSweep(
  service: Pick<ProjectTrackingService, "sweep">,
  report: (error: unknown) => void,
  intervalMs = SWEEP_INTERVAL_MS,
): { stop(): void } {
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    void service
      .sweep()
      .catch(report)
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(pass, intervalMs);
  timer.unref();
  pass();
  return { stop: () => clearInterval(timer) };
}

export function createProjectTrackingRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  service: ProjectTrackingService,
): Hono {
  const app = new Hono();
  for (const path of [PROJECT_TRACKING_PATH, PROJECT_TRACKING_APPLY_PATH]) {
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      const authority = await authorize(context.req.raw);
      if (authority !== true)
        return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
      await next();
    });
    app.use(path, bodyLimit({ maxSize: 4 * 1024 }));
  }
  app.get(PROJECT_TRACKING_PATH, async (context) => {
    const view = await service.view(context.req.query("projectId") ?? "");
    return view ? context.json(view) : context.json({ error: "unknown_project" }, 404);
  });
  app.post(PROJECT_TRACKING_APPLY_PATH, async (context) => {
    // allow-swallowed-rejection -- an unreadable body is the malformed reply below
    const input = ApplyProjectTrackingSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    const request = context.req.raw;
    // The owner who sent this, renewed before each write, for as long as they wait on it.
    const result = await service.apply(input.data.projectId, input.data.expectedRevision, {
      current: () => !request.signal.aborted,
      authorize: async () => !request.signal.aborted && (await authorize(request)) === true,
    });
    if (result === "unknown_project") return context.json({ error: result }, 404);
    if (typeof result === "string") return context.json({ error: result }, 409);
    return context.json({ projectId: input.data.projectId, repos: result });
  });
  return app;
}
