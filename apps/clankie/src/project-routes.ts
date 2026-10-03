import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { projectsRevision, removeProjectWorkspace, type SettingsStore } from "@clankie/settings";
import {
  PROJECTS_PATH,
  PROJECT_REMOVE_WORKSPACE_PATH,
  RemoveProjectWorkspaceSchema,
} from "@clankie/protocol/projects";

/** Owner-only configuration. Registration and removal confer no grant or process authority. */
export function createProjectRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
): Hono {
  const app = new Hono();
  for (const path of [PROJECTS_PATH, PROJECT_REMOVE_WORKSPACE_PATH]) {
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      const authority = await authorize(context.req.raw);
      if (authority !== true)
        return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
      await next();
    });
    app.use(path, bodyLimit({ maxSize: 16 * 1024 }));
  }
  app.get(PROJECTS_PATH, async (context) => {
    const value = (await settings.load()).projects;
    return context.json({ settings: value, revision: projectsRevision(value) });
  });
  app.post(PROJECT_REMOVE_WORKSPACE_PATH, async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = RemoveProjectWorkspaceSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          before = JSON.stringify(current);
          return { ...current, projects: removeProjectWorkspace(current.projects, input.data) };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      return context.json({ settings: updated.projects, revision: projectsRevision(updated.projects) });
    } catch {
      return context.json({ error: "workspace_removal_conflict" }, 409);
    }
  });
  return app;
}
