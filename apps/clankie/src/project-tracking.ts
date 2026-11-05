import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SettingsStore } from "@clankie/settings";
import type { GithubApi } from "@clankie/work-items";
import {
  PROJECT_TRACKING_PATH,
  ProjectTrackingRequestSchema,
  ProjectTrackingResultSchema,
  type ProjectTrackingRequest,
  type ProjectTrackingResult,
} from "@clankie/protocol/project-tracking";
import { inferProjectTracking } from "./project-tracking-inference.ts";
import { syncTrackingGuide } from "./project-tracking-guide.ts";

type Github = { api: GithubApi; assertCurrent(): void };
export class ProjectTrackingService {
  private readonly settings: Pick<SettingsStore, "loadFenced" | "update">;
  private readonly github: () => Promise<Github>;
  private queue = Promise.resolve();
  private closed = false;
  public constructor(settings: Pick<SettingsStore, "loadFenced" | "update">, github: () => Promise<Github>) {
    this.settings = settings;
    this.github = github;
  }
  public run(
    request: ProjectTrackingRequest,
    requireOwner: () => Promise<void> = async () => {},
  ): Promise<ProjectTrackingResult> {
    const run = this.queue.then(() => this.execute(request, requireOwner));
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  private async execute(
    request: ProjectTrackingRequest,
    requireOwner: () => Promise<void>,
  ): Promise<ProjectTrackingResult> {
    if (this.closed) throw new Error("tracking_closed");
    const read = await this.settings.loadFenced();
    const project = read.settings.projects.projects.find((p) => p.id === request.projectId);
    if (!project) throw new Error("unknown_project");
    const revision = createHash("sha256").update(JSON.stringify(project)).digest("hex");
    if ("expectedRevision" in request && request.expectedRevision !== revision)
      throw new Error("tracking_settings_changed");
    const result: ProjectTrackingResult = {
      projectId: project.id,
      revision,
      ...(project.tracking ? { selection: project.tracking } : {}),
      decision: project.tracking ? "configured" : "confirmation_required",
      signals: [],
      guides: [],
    };
    if (request.action === "preview") {
      await requireOwner();
      read.assertCurrent();
      return { ...result, proposed: request.selection, decision: "proposal" };
    }
    if (request.action === "read") {
      await requireOwner();
      read.assertCurrent();
      return result;
    }
    const connection = await this.github();
    const guard = async () => {
      if (this.closed) throw new Error("tracking_closed");
      await requireOwner();
      read.assertCurrent();
      connection.assertCurrent();
    };
    await guard();
    if (request.action === "infer") {
      const inferred = await inferProjectTracking(project, connection.api);
      await guard();
      result.signals = inferred.signals;
      if (!inferred.proposed) return result;
      if (project.tracking)
        return {
          ...result,
          proposed: inferred.proposed,
          decision:
            JSON.stringify(project.tracking) === JSON.stringify(inferred.proposed)
              ? "configured"
              : "proposal",
        };
      request = {
        action: "apply",
        projectId: request.projectId,
        expectedRevision: revision,
        selection: inferred.proposed,
      };
      result.decision = "inferred";
    }
    if (request.action === "apply") {
      const selection = request.selection;
      // Visibility is a live forge fact, not the request's assertion about a private repo.
      for (const repo of selection.repositories) {
        const value = (await connection.api.request("GET", `repos/${repo.repository}`)) as {
          full_name?: unknown;
          private?: unknown;
        };
        if (
          typeof value.full_name !== "string" ||
          value.full_name.toLowerCase() !== repo.repository.toLowerCase() ||
          value.private !== (repo.visibility === "private")
        )
          throw new Error("tracking_repository_changed");
      }
      const committed = await this.settings.update((current) => {
        for (const other of current.projects.projects.filter((p) => p.id !== project.id))
          if (
            other.tracking?.repositories.some((repo) =>
              selection.repositories.some(
                (entry) => entry.repository.toLowerCase() === repo.repository.toLowerCase(),
              ),
            )
          )
            throw new Error("tracking_repository_already_owned");
        return {
          ...current,
          projects: {
            ...current.projects,
            projects: current.projects.projects.map((p) =>
              p.id === project.id
                ? { ...p, tracking: selection, trackingConfirmedAt: new Date().toISOString() }
                : p,
            ),
          },
        };
      }, guard);
      // Re-observe the committed setting for the writer. The stale request witness is never reused.
      return {
        ...(await this.execute(
          {
            action: "sync",
            projectId: project.id,
            expectedRevision: createHash("sha256")
              .update(JSON.stringify(committed.projects.projects.find((p) => p.id === project.id)))
              .digest("hex"),
          },
          requireOwner,
        )),
        decision: result.decision === "inferred" ? "inferred" : "configured",
      };
    }
    if (!project.tracking) return result;
    for (const repo of project.tracking.repositories)
      result.guides.push(
        await syncTrackingGuide({
          projectId: project.id,
          tracking: project.tracking,
          repo,
          api: connection.api,
          guard,
        }),
      );
    await guard();
    return ProjectTrackingResultSchema.parse(result);
  }
  /** No tracker switching: existing settings yield proposals only; confirmed guide drift yields PRs. */
  public async sweep(): Promise<void> {
    const read = await this.settings.loadFenced();
    for (const project of read.settings.projects.projects) {
      if (this.closed) return;
      const revision = createHash("sha256").update(JSON.stringify(project)).digest("hex");
      await this.run({ action: "infer", projectId: project.id, expectedRevision: revision });
      const latest = (await this.settings.loadFenced()).settings.projects.projects.find(
        (p) => p.id === project.id,
      );
      if (latest?.tracking)
        await this.run({
          action: "sync",
          projectId: latest.id,
          expectedRevision: createHash("sha256").update(JSON.stringify(latest)).digest("hex"),
        });
    }
  }
  public async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}

export function createProjectTrackingRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  service: ProjectTrackingService,
) {
  const app = new Hono();
  app.use(PROJECT_TRACKING_PATH, bodyLimit({ maxSize: 32 * 1024 }));
  app.on(["GET", "POST"], PROJECT_TRACKING_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    const query = new URL(context.req.url).searchParams;
    if (
      context.req.method === "GET" &&
      ([...query.keys()].some((key) => key !== "projectId") || query.getAll("projectId").length !== 1)
    )
      return context.json({ error: "malformed" }, 400);
    const parsed = ProjectTrackingRequestSchema.safeParse(
      context.req.method === "GET"
        ? { action: "read", projectId: query.get("projectId") }
        : await context.req.json().catch(() => null),
    );
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    try {
      return context.json(
        await service.run(parsed.data, async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("forbidden");
        }),
      );
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error &&
            [
              "unknown_project",
              "tracking_settings_changed",
              "tracking_repository_changed",
              "forbidden",
            ].includes(error.message)
              ? error.message
              : "tracking_unavailable",
        },
        409,
      );
    }
  });
  return app;
}
