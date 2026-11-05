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
import { inspectTrackingRepo, proposeTrackingRepo, type GithubApi } from "@clankie/work-items";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface TrackingLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/** Deterministic end to end: settings in, a template out, one small proposal per repo. */
export function createProjectTrackingService(options: {
  readonly settings: { load(): Promise<ClankieSettings> };
  /** The forge the proposals go through, resolved for each pass so a reconnect takes effect. */
  readonly forge: () => Promise<GithubApi>;
  readonly suggest?: (project: Project) => Promise<ProjectTrackingSuggestion | undefined>;
  readonly logger?: TrackingLogger;
}) {
  const forEachRepo = async (
    project: Project,
    visit: (api: GithubApi, repo: string) => Promise<TrackingRepoStatus>,
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
    for (const repo of repos) statuses.push(await visit(api, repo));
    return statuses;
  };
  return {
    /** Read-only. For a repo whose proposal merged, this is the read-back. */
    async view(projectId: string): Promise<ProjectTrackingView | undefined> {
      const current = await options.settings.load();
      const project = current.projects.projects.find((saved) => saved.id === projectId);
      if (!project) return undefined;
      const tracker = project.tracking?.tracker;
      const suggestion = await options.suggest?.(project).catch(() => undefined);
      return {
        projectId,
        revision: projectsRevision(current.projects),
        ...(project.tracking ? { tracking: project.tracking } : {}),
        repos: await forEachRepo(project, (api, repo) => inspectTrackingRepo(api, repo, tracker!)),
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
      return forEachRepo(project, (api, repo) =>
        proposeTrackingRepo(api, repo, tracker, { reopenDeclined: true }),
      );
    },
    /**
     * Every project with a setting, unattended. Under `push: owner` it only reads, because
     * nobody at the keyboard said to push: the owner sees the drift and applies it themselves.
     */
    async sweep(): Promise<void> {
      const current = await options.settings.load();
      for (const project of current.projects.projects) {
        const tracker = project.tracking?.tracker;
        if (!tracker) continue;
        const proposes = effectiveFleetAutonomy(current.autonomy, project.autonomy).push === "lead";
        const statuses = await forEachRepo(project, (api, repo) =>
          proposes ? proposeTrackingRepo(api, repo, tracker) : inspectTrackingRepo(api, repo, tracker),
        );
        const unsettled = statuses.filter((status) => status.state !== "in_step");
        const suggestion = await options.suggest?.(project).catch(() => undefined);
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
    const input = ApplyProjectTrackingSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    const result = await service.apply(input.data.projectId, input.data.expectedRevision);
    if (result === "unknown_project") return context.json({ error: result }, 404);
    if (typeof result === "string") return context.json({ error: result }, 409);
    return context.json({ projectId: input.data.projectId, repos: result });
  });
  return app;
}
