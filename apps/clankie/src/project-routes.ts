import { createModelRegistry, resolveHireModel } from "@clankie/model-registry";
import { effectiveHireProfile } from "@clankie/protocol";
import { applyProjectCreate } from "./project-create.ts";
import { isDeepStrictEqual } from "node:util";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  projectsRevision,
  ProjectTrackerUnavailable,
  removeProjectWorkspace,
  addProjectWorktreeRoot,
  removeProjectWorktreeRoot,
  observeLocalProjectWorktreeRoot,
  type ObserveProjectWorktreeRoot,
  type SettingsStore,
  updateProjectSettings,
  type ClankieSettings,
} from "@clankie/settings";
import {
  PROJECTS_PATH,
  PROJECT_CREATE_SETTINGS_PATH,
  CreateProjectSettingsSchema,
  PROJECT_REMOVE_WORKSPACE_PATH,
  RemoveProjectWorkspaceSchema,
  PROJECT_ADD_WORKTREE_ROOT_PATH,
  PROJECT_REMOVE_WORKTREE_ROOT_PATH,
  AddProjectWorktreeRootSchema,
  RemoveProjectWorktreeRootSchema,
  PROJECT_UPDATE_SETTINGS_PATH,
  UpdateProjectSettingsSchema,
} from "@clankie/protocol/projects";

/** Legacy strict clients keep their existing view; the revision always binds full stored policy. */
function projectSnapshot(current: ClankieSettings, includeAutonomy: boolean) {
  return {
    settings: includeAutonomy
      ? current.projects
      : {
          ...current.projects,
          projects: current.projects.projects.map(({ autonomy: _autonomy, ...project }) => project),
        },
    ...(current.fleet.hire ? { hireDefaults: current.fleet.hire } : {}),
    ...(includeAutonomy ? { autonomyDefaults: current.autonomy } : {}),
    ...(includeAutonomy ? { workingPreferences: true, fleetGates: true } : {}),
    revision: projectsRevision(current.projects),
  };
}

/** Owner-only configuration. Registration and removal confer no grant or process authority. */
export function createProjectRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  options: { worktreeRoot?: ObserveProjectWorktreeRoot } = {},
): Hono {
  const app = new Hono();
  for (const path of [
    PROJECTS_PATH,
    PROJECT_CREATE_SETTINGS_PATH,
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
    const current = await settings.load();
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    return context.json(projectSnapshot(current, context.req.query("includeAutonomy") === "true"));
  });
  app.post(PROJECT_CREATE_SETTINGS_PATH, async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = CreateProjectSettingsSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    const requireOwner = async () => {
      if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
    };
    try {
      const result = await applyProjectCreate(
        { load: () => settings.load(), update: (mutate, guard) => settings.update!(mutate, guard) },
        input.data,
        requireOwner,
      );
      // Keep the committed generation's full revision while projecting the caller's view.
      const current = await settings.load();
      const projected = projectSnapshot(
        { ...current, projects: result.settings },
        context.req.query("includeAutonomy") === "true",
      );
      return context.json({ ...projected, revision: result.revision }, 201);
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof ProjectTrackerUnavailable
              ? "project_tracker_unavailable"
              : "project_create_conflict",
        },
        409,
      );
    }
  });
  app.post(PROJECT_UPDATE_SETTINGS_PATH, async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateProjectSettingsSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    try {
      const current = await settings.load();
      const catalog = await createModelRegistry().catalog();
      for (const role of input.data.changes.roles ?? []) {
        const profile = effectiveHireProfile({}, role, current.fleet.hire);
        for (const model of [profile.model, profile.subagents?.model])
          if (model) resolveHireModel(catalog, profile.harness, model);
      }
    } catch (error) {
      return context.json({ error: "invalid_hire_model", detail: String(error) }, 400);
    }
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
      return context.json(projectSnapshot(updated, context.req.query("includeAutonomy") === "true"));
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
      return context.json(projectSnapshot(updated, context.req.query("includeAutonomy") === "true"));
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
      return context.json(projectSnapshot(updated, context.req.query("includeAutonomy") === "true"));
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
      return context.json(projectSnapshot(updated, context.req.query("includeAutonomy") === "true"));
    } catch {
      return context.json({ error: "worktree_root_removal_conflict" }, 409);
    }
  });
  return app;
}
