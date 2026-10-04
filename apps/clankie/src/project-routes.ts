import { isDeepStrictEqual } from "node:util";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  projectsRevision,
  removeProjectWorkspace,
  addProjectWorktreeRoot,
  removeProjectWorktreeRoot,
  observeLocalProjectWorktreeRoot,
  type ObserveProjectWorktreeRoot,
  type SettingsStore,
  updateProjectSettings,
} from "@clankie/settings";
import {
  PROJECTS_PATH,
  PROJECT_REMOVE_WORKSPACE_PATH,
  RemoveProjectWorkspaceSchema,
  PROJECT_ADD_WORKTREE_ROOT_PATH,
  PROJECT_REMOVE_WORKTREE_ROOT_PATH,
  AddProjectWorktreeRootSchema,
  RemoveProjectWorktreeRootSchema,
  PROJECT_UPDATE_SETTINGS_PATH,
  UpdateProjectSettingsSchema,
} from "@clankie/protocol/projects";

/** Owner-only configuration. Registration and removal confer no grant or process authority. */
export function createProjectRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  options: { worktreeRoot?: ObserveProjectWorktreeRoot } = {},
): Hono {
  const app = new Hono();
  for (const path of [
    PROJECTS_PATH,
    PROJECT_UPDATE_SETTINGS_PATH,
    PROJECT_REMOVE_WORKSPACE_PATH,
    PROJECT_ADD_WORKTREE_ROOT_PATH,
    PROJECT_REMOVE_WORKTREE_ROOT_PATH,
  ]) {
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
  app.post(PROJECT_UPDATE_SETTINGS_PATH, async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateProjectSettingsSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          before = JSON.stringify(current);
          return { ...current, projects: updateProjectSettings(current.projects, input.data) };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      return context.json({ settings: updated.projects, revision: projectsRevision(updated.projects) });
    } catch {
      return context.json({ error: "project_update_conflict" }, 409);
    }
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
  app.post(PROJECT_ADD_WORKTREE_ROOT_PATH, async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = AddProjectWorktreeRootSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    const observe = options.worktreeRoot ?? observeLocalProjectWorktreeRoot;
    const initial = await observe(input.data).catch(() => undefined);
    if (!initial) return context.json({ error: "unverified_worktree_root" }, 409);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          before = JSON.stringify(current);
          return { ...current, projects: addProjectWorktreeRoot(current.projects, input.data, initial) };
        },
        async () => {
          if (!isDeepStrictEqual(await observe(input.data), initial))
            throw new Error("Worktree root changed");
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      return context.json({ settings: updated.projects, revision: projectsRevision(updated.projects) });
    } catch {
      return context.json({ error: "worktree_root_conflict" }, 409);
    }
  });
  app.post(PROJECT_REMOVE_WORKTREE_ROOT_PATH, async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = RemoveProjectWorktreeRootSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          before = JSON.stringify(current);
          return { ...current, projects: removeProjectWorktreeRoot(current.projects, input.data) };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      return context.json({ settings: updated.projects, revision: projectsRevision(updated.projects) });
    } catch {
      return context.json({ error: "worktree_root_removal_conflict" }, 409);
    }
  });
  return app;
}
