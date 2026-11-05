import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { effectiveFleetAutonomy } from "@clankie/protocol";
import type { Project } from "@clankie/protocol/projects";
import {
  ApplyProjectTrackingSchema,
  PROJECT_TRACKING_APPLY_PATH,
  PROJECT_TRACKING_PATH,
  type ProjectTrackingSuggestion,
  type ProjectTrackingView,
  type TrackingRepoStatus,
} from "@clankie/protocol/project-tracking";
import { projectsRevision, type ClankieSettings } from "@clankie/settings";
import {
  inspectTrackingRepo,
  proposeTrackingRepo,
  TRACKING_BRANCH,
  type GithubApi,
} from "@clankie/work-items";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface TrackingLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/** The text never carries the board itself: an alert can travel further than the setting does. */
function exposureAlert(projectId: string, status: TrackingRepoStatus): string {
  const where = status.reason?.startsWith("private_board_published")
    ? "its default branch"
    : status.pull
      ? `its proposal #${String(status.pull.number)}`
      : `its ${TRACKING_BRANCH} branch`;
  return `${status.repo} is no longer confirmed private, and ${where} still names the private board. Clankie left it in place. \`clankie project tracking ${projectId} apply\` withdraws or replaces it; the repo's merged history is yours to manage.`;
}

/** Deterministic end to end: settings in, a template out, one small proposal per repo. */
export function createProjectTrackingService(options: {
  readonly settings: { load(): Promise<ClankieSettings> };
  /** The forge the proposals go through, resolved for each pass so a reconnect takes effect. */
  readonly forge: () => Promise<GithubApi>;
  readonly suggest?: (project: Project) => Promise<ProjectTrackingSuggestion | undefined>;
  readonly logger?: TrackingLogger;
  /** Reaches the owner; false means it did not, and the next sweep tries again. */
  readonly alert?: (text: string) => Promise<boolean>;
}) {
  const alerted = new Set<string>();
  const alertExposure = async (projectId: string, status: TrackingRepoStatus) => {
    const key = `${projectId}\n${status.repo}\n${String(status.pull?.number)}\n${status.reason ?? ""}`;
    if (alerted.has(key)) return;
    const delivered = await options.alert?.(exposureAlert(projectId, status)).catch((error: unknown) => {
      options.logger?.warn(
        { event: "project_tracking.alert_failed", projectId, repo: status.repo, error: String(error) },
        "Could not alert the owner about a private board",
      );
      return false;
    });
    if (delivered) alerted.add(key);
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
    visit: (api: GithubApi, repo: string, sharedWith: string | undefined) => Promise<TrackingRepoStatus>,
  ): Promise<TrackingRepoStatus[]> => {
    const repos = project.tracking?.repos ?? [];
    if (repos.length === 0) return [];
    let api: GithubApi;
    try {
      api = await options.forge();
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
        repos: await forEachRepo(current.projects.projects, project, (api, repo, sharedWith) =>
          inspectTrackingRepo(api, repo, tracker!, sharedWith === undefined ? {} : { sharedWith }),
        ),
        ...(suggestion ? { suggestion } : {}),
      };
    },
    /** The owner's own apply, bound to the revision they reviewed. It reopens a declined proposal. */
    async apply(projectId: string, expectedRevision: string) {
      const current = await options.settings.load();
      if (projectsRevision(current.projects) !== expectedRevision) return "stale_revision" as const;
      const project = current.projects.projects.find((saved) => saved.id === projectId);
      if (!project) return "unknown_project" as const;
      const tracker = project.tracking?.tracker;
      if (!tracker) return "no_tracking" as const;
      return forEachRepo(current.projects.projects, project, (api, repo, sharedWith) =>
        proposeTrackingRepo(api, repo, tracker, {
          reopenDeclined: true,
          ...(sharedWith === undefined ? {} : { sharedWith }),
        }),
      );
    },
    /**
     * Every project with a setting, unattended. Under `push: owner` it only reads, because
     * nobody at the keyboard said to push: the owner sees the drift and applies it themselves,
     * and a private board left in the open reaches them as an alert.
     */
    async sweep(): Promise<void> {
      const current = await options.settings.load();
      for (const project of current.projects.projects) {
        const tracker = project.tracking?.tracker;
        if (!tracker) continue;
        const proposes = effectiveFleetAutonomy(current.autonomy, project.autonomy).push === "lead";
        const statuses = await forEachRepo(current.projects.projects, project, (api, repo, sharedWith) => {
          const repoOptions = sharedWith === undefined ? {} : { sharedWith };
          return proposes
            ? proposeTrackingRepo(api, repo, tracker, repoOptions)
            : inspectTrackingRepo(api, repo, tracker, repoOptions);
        });
        for (const status of statuses)
          if (status.reason?.startsWith("private_board_")) await alertExposure(project.id, status);
        const unsettled = statuses.filter(
          (status) => status.state !== "in_step" || status.withdrawnPull !== undefined,
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

/** One pass at a time; a failed pass waits for the next tick, and a stop leaves no timer. */
export function startProjectTrackingSweep(
  service: Pick<ProjectTrackingService, "sweep">,
  report: (error: unknown) => void,
  intervalMs = SWEEP_INTERVAL_MS,
): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void service
      .sweep()
      .catch(report)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
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
    const result = await service.apply(input.data.projectId, input.data.expectedRevision);
    if (result === "unknown_project") return context.json({ error: result }, 404);
    if (typeof result === "string") return context.json({ error: result }, 409);
    return context.json({ projectId: input.data.projectId, repos: result });
  });
  return app;
}
