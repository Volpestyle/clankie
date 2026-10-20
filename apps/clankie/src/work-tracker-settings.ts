import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  WORK_TRACKER_SETTINGS_PATH,
  WORK_TRACKER_CHANGE_EFFECT,
  WorkTrackerSettingsRequestSchema,
  WorkTrackerSelectionSchema,
  type WorkTrackerSelection,
  type WorkTrackerSettingsRequest,
} from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import type { SettingsStore } from "@clankie/settings";
import { readConvention, writeConvention, type TrackerToolBackend } from "@clankie/work-items";
import type { WorkConvention } from "@clankie/protocol/work-items";
import type { AccountsPort } from "./accounts.ts";

export function trackerInit(selection: WorkTrackerSelection) {
  switch (selection.backend) {
    case "builtin":
      return { backend: "builtin" as const };
    case "linear":
      return {
        backend: "linear" as const,
        linearTeam: selection.team,
        linearProject: selection.project,
        ...(selection.label ? { linearLabel: selection.label } : {}),
      };
    case "github":
      return { backend: "github" as const, githubRepo: selection.repo };
    case "markdown":
      return { backend: "markdown" as const, directory: selection.directory };
  }
}
function selected(
  convention: WorkConvention | undefined,
  projectId?: string,
): WorkTrackerSelection | undefined {
  if (!convention) return undefined;
  switch (convention.backend) {
    case "builtin":
      return { backend: "builtin", ...(projectId ? { projectId } : {}) };
    case "linear":
      return WorkTrackerSelectionSchema.safeParse({ backend: "linear", ...convention.linear }).data;
    case "github":
      return WorkTrackerSelectionSchema.parse({ backend: "github", ...convention.github });
    case "default":
      return { backend: "markdown", directory: ".clankie/work" };
    case "markdown":
      return WorkTrackerSelectionSchema.parse({ backend: "markdown", directory: convention.directory });
  }
}
/** One owner API for all clients. Preview and apply share the exact state/target fingerprint. */
export function createWorkTrackerSettingsRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  options: { accounts?: Pick<AccountsPort, "list">; tracker?: TrackerToolBackend } = {},
) {
  const app = new Hono();
  let queue = Promise.resolve();
  app.use(WORK_TRACKER_SETTINGS_PATH, bodyLimit({ maxSize: 16 * 1024 }));
  app.on(["GET", "POST"], WORK_TRACKER_SETTINGS_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const requireOwner = async () => {
      if ((await authorize(context.req.raw)) !== true) throw new Error("forbidden");
    };
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    const query = new URL(context.req.url).searchParams;
    if (
      context.req.method === "GET" &&
      ([...query.keys()].some((key) => key !== "projectId") || query.getAll("projectId").length > 1)
    )
      return context.json({ error: "malformed" }, 400);
    const body =
      context.req.method === "GET"
        ? { action: "read", ...(query.has("projectId") ? { projectId: query.get("projectId") } : {}) }
        : // allow-swallowed-rejection -- Invalid JSON follows the explicit malformed-request refusal below.
          await context.req.json().catch(() => null);
    const parsed = WorkTrackerSettingsRequestSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const request = parsed.data;
    const observe = async (input: WorkTrackerSettingsRequest) => {
      const current = await settings.load();
      const project = input.projectId
        ? current.projects.projects.find((p) => p.id === input.projectId)
        : undefined;
      if (input.projectId && !project) throw new Error("unknown_project");
      const workspace =
        project &&
        (project.trackerRef
          ? project.workspaces.find((w) => w.id === project.trackerRef!.workspaceId)
          : project.workspaces.find((w) => w.machineId === "local"));
      if (
        project &&
        (!workspace ||
          workspace.machineId !== "local" ||
          workspace.platform !== (process.platform === "win32" ? "windows" : "posix"))
      )
        throw new Error("tracker_workspace_unavailable");
      let convention: WorkConvention | undefined;
      let identity: unknown;
      let bytes: string | undefined;
      if (workspace) {
        if ((await realpath(workspace.path)) !== workspace.path) throw new Error("tracker_workspace_changed");
        const root = await lstat(workspace.path);
        identity = [root.dev, root.ino];
        const parent = join(workspace.path, ".clankie");
        try {
          if ((await realpath(parent)) !== parent) throw new Error("tracker_path_changed");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        const file = join(parent, "tracking.json");
        try {
          if (!(await lstat(file)).isFile()) throw new Error("tracker_path_changed");
          bytes = await readFile(file, "utf8");
          convention = await readConvention(workspace.path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      // allow-swallowed-rejection -- Failed account reads fail closed for external trackers; account-free trackers stay available.
      const accounts = await options.accounts?.list().catch(() => undefined);
      const connections = {
        linear:
          accounts?.connections.some((c) => c.provider === "linear" && c.status === "connected") ?? false,
        github:
          accounts?.connections.some((c) => c.provider === "github" && c.status === "connected") ?? false,
      };
      const proposed = input.action === "read" ? undefined : input.selection;
      const revision = createHash("sha256")
        .update(
          JSON.stringify({
            default: current.workTrackerDefault,
            projects: current.projects,
            identity,
            bytes,
            proposed,
            accounts: accounts?.connections.map(
              ({ provider, status, account, workspace, actor, scopes }) => ({
                provider,
                status,
                account,
                workspace,
                actor,
                scopes,
              }),
            ),
          }),
        )
        .digest("hex");
      return {
        current,
        project,
        workspace,
        bytes,
        convention,
        snapshot: {
          revision,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          default: current.workTrackerDefault ?? { backend: "builtin" as const },
          ...(project
            ? { selection: selected(convention, project.trackerProjectId) }
            : { selection: current.workTrackerDefault ?? { backend: "builtin" as const } }),
          source: !project
            ? ("global" as const)
            : convention?.backend === "default"
              ? ("legacy_files" as const)
              : convention
                ? ("project" as const)
                : ("unconfigured" as const),
          ...(proposed ? { proposed } : {}),
          effect: project
            ? WORK_TRACKER_CHANGE_EFFECT
            : "Applies to new projects only. Existing projects keep their saved tracker and items.",
          confirmationRequired: !!project && input.action !== "read",
          connections,
        },
      };
    };
    const run = async () => {
      const before = await observe(request);
      await requireOwner();
      if (request.action !== "apply") return context.json(before.snapshot);
      if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
      if (request.expectedRevision !== before.snapshot.revision)
        return context.json({ error: "tracker_settings_changed" }, 409);
      if (before.project && request.confirmRetainItems !== true)
        return context.json({ error: "tracker_confirmation_required", ...before.snapshot }, 409);
      if (
        (request.selection.backend === "linear" || request.selection.backend === "github") &&
        !before.snapshot.connections[request.selection.backend]
      )
        return context.json({ error: "tracker_account_not_connected" }, 409);
      let selection = request.selection;
      if (!before.project && selection.backend === "builtin" && selection.projectId)
        throw new Error("default_builtin_target_is_per_project");
      if (before.project && selection.backend === "builtin") {
        if (!options.tracker) throw new Error("builtin_tracker_unavailable");
        if (selection.projectId) {
          const found = (await options.tracker.call("get_project", { query: selection.projectId })) as {
            id: string;
          };
          if (found.id !== selection.projectId) throw new Error("tracker_project_not_found");
        } else {
          // Reuse this project's existing store on switch-back; never merge or overwrite it.
          const found = before.project.trackerProjectId
            ? { id: before.project.trackerProjectId }
            : ((await options.tracker.call("save_project", {
                name: before.project.name,
                addTeams: ["LOCAL"],
              })) as { id: string });
          selection = { backend: "builtin", projectId: found.id };
        }
        if (
          before.current.projects.projects.some(
            (p) =>
              p.id !== before.project!.id &&
              p.trackerProjectId === (selection as { projectId: string }).projectId,
          )
        )
          throw new Error("tracker_project_already_bound");
      }
      let written: WorkConvention | undefined;
      try {
        await settings.update(
          (current) => {
            if (JSON.stringify(current) !== JSON.stringify(before.current))
              throw new Error("tracker_settings_changed");
            if (!before.project) return { ...current, workTrackerDefault: selection };
            const project = {
              ...before.project,
              trackerRef: { workspaceId: before.workspace!.id, path: ".clankie/tracking.json" as const },
              ...(selection.backend === "builtin" ? { trackerProjectId: selection.projectId } : {}),
            };
            // Keep the previous builtin UUID for switching back, but routing still follows the convention.
            return {
              ...current,
              projects: ProjectsSettingsSchema.parse({
                ...current.projects,
                projects: current.projects.projects.map((p) => (p.id === project.id ? project : p)),
              }),
            };
          },
          async () => {
            await requireOwner();
            if ((await observe(request)).snapshot.revision !== request.expectedRevision)
              throw new Error("tracker_settings_changed");
            if (before.workspace) {
              const init = trackerInit(selection);
              const { backend } = init;
              written = {
                schemaVersion: 1,
                backend,
                decidedBy: "owner",
                decidedAt: new Date().toISOString(),
                ...(before.convention?.decisions ? { decisions: before.convention.decisions } : {}),
                ...(before.convention?.releases ? { releases: before.convention.releases } : {}),
                ...(selection.backend === "linear"
                  ? {
                      linear: {
                        team: selection.team,
                        project: selection.project,
                        ...(selection.label ? { label: selection.label } : {}),
                      },
                    }
                  : {}),
                ...(selection.backend === "github" ? { github: { repo: selection.repo } } : {}),
                ...(selection.backend === "markdown" ? { directory: selection.directory } : {}),
              };
              await writeConvention(before.workspace.path, written, async () => {
                await requireOwner();
                if ((await observe(request)).snapshot.revision !== request.expectedRevision)
                  throw new Error("tracker_settings_changed");
              });
            }
          },
        );
      } catch (error) {
        // Restore only our own publication, never a later writer's choice.
        if (
          written &&
          before.workspace &&
          JSON.stringify(await readConvention(before.workspace.path)) === JSON.stringify(written)
        ) {
          const path = join(before.workspace.path, ".clankie/tracking.json");
          if (before.bytes === undefined) await rm(path);
          else await writeFile(path, before.bytes);
        }
        throw error;
      }
      const after = await observe({
        action: "read",
        ...(request.projectId ? { projectId: request.projectId } : {}),
      });
      return context.json(after.snapshot);
    };
    const pending = queue.then(run, run);
    queue = pending.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await pending;
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : "tracker_settings_unavailable" },
        409,
      );
    }
  });
  return app;
}
