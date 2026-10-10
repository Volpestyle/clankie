/**
 * `/project` as a modal: pick a project, then edit its name, worker cap,
 * tracker, hire roles and workspaces in place. Every read and write goes
 * through the same revision-bearing clients as `clankie project`, so a stale
 * revision is refused here exactly as it is on the CLI.
 */
import { ProjectIdSchema, ProjectsSnapshotSchema, type Project } from "@clankie/protocol/projects";
import type { ClankieFaceShell } from "./shell/shell.ts";
import type { SetupFlow } from "./shell/setup-flow.ts";

type Run = (args: readonly string[]) => Promise<unknown>;
export interface ProjectsMenuServices {
  /** `clankie project list|create|update` (runProjectSettingsCommand). */
  readonly settings: Run;
  /** `clankie project add|remove-workspace` (runProjectCommand). */
  readonly workspace: Run;
  readonly roles: (projectId: string) => Promise<void>;
  readonly cwd?: string;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const home = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+/u, "~");

async function attempt(flow: SetupFlow, work: () => Promise<unknown>, done: string): Promise<void> {
  try {
    await work();
    flow.renderLine(done, "success");
  } catch (error) {
    flow.renderLine(message(error), "error");
  }
}

/** `id · 3 roles · cap 4 · tracker` — the facts worth seeing before opening a project. */
function projectHint(project: Project): string {
  return [
    project.id,
    project.roles.length
      ? `${project.roles.length} role${project.roles.length === 1 ? "" : "s"}`
      : "built-in roles",
    ...(project.auto === true ? ["Auto"] : []),
    ...(project.workerCap === undefined ? [] : [`cap ${project.workerCap}`]),
    ...(project.trackerRef ? ["tracker"] : []),
  ].join(" · ");
}

export async function runProjectsMenu(
  shell: ClankieFaceShell,
  services: ProjectsMenuServices,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("projects");
  try {
    for (;;) {
      const snapshot = ProjectsSnapshotSchema.parse(await services.settings(["list"]));
      const projects = snapshot.settings.projects;
      const choice = await flow.readSelect({
        message: projects.length ? `Projects (${projects.length})` : "No projects yet",
        options: [
          ...projects.map((project) => ({
            value: `project:${project.id}`,
            label: project.name,
            hint: projectHint(project),
            ...(project.workspaces[0] ? { description: home(project.workspaces[0].path) } : {}),
          })),
          { value: "create", label: "New project…", hint: "from a local folder" },
        ],
        allowBack: true,
      });
      if (choice === undefined) return;
      if (choice === "create") {
        await createProject(flow, services, snapshot.revision);
        continue;
      }
      await projectDetail(shell, services, choice.slice("project:".length));
    }
  } catch (error) {
    shell.insertCommandResult("/project", message(error), "error");
  } finally {
    flow.end();
  }
}

async function createProject(flow: SetupFlow, services: ProjectsMenuServices, revision: string) {
  const id = await flow.readText({
    message: "Project id",
    placeholder: "lowercase, e.g. clankie",
    allowBack: true,
    validate: (value) =>
      ProjectIdSchema.safeParse(value.trim()).success
        ? undefined
        : "Start with a letter; lowercase letters, digits, - and _.",
  });
  if (id === undefined) return;
  const name = await flow.readText({ message: "Display name", defaultValue: id.trim(), allowBack: true });
  if (name === undefined) return;
  const path = await flow.readText({
    message: "Workspace folder (absolute path)",
    ...(services.cwd === undefined ? {} : { defaultValue: services.cwd }),
    allowBack: true,
    validate: (value) => (value.trim().startsWith("/") ? undefined : "Use an absolute path."),
  });
  if (path === undefined) return;
  await attempt(
    flow,
    () =>
      services.settings([
        "create",
        id.trim(),
        "--settings-json",
        JSON.stringify({ name: name.trim(), workspacePath: path.trim() }),
        "--revision",
        revision,
      ]),
    `Created ${name.trim()}.`,
  );
}

async function projectDetail(shell: ClankieFaceShell, services: ProjectsMenuServices, id: string) {
  const flow = shell.setupFlow;
  for (;;) {
    const snapshot = ProjectsSnapshotSchema.parse(await services.settings(["list"]));
    const project = snapshot.settings.projects.find((entry) => entry.id === id);
    if (!project) return;
    const update = (changes: Record<string, unknown>, done: string) =>
      attempt(
        flow,
        () =>
          services.settings([
            "update",
            id,
            "--changes-json",
            JSON.stringify(changes),
            "--revision",
            snapshot.revision,
          ]),
        done,
      );
    const fleet = [project.fleet?.size, project.fleet?.models].filter(Boolean).join(" · ");
    const choice = await flow.readSelect({
      message: `${project.name} · ${project.id}${fleet ? ` · fleet ${fleet}` : ""}`,
      options: [
        ...(snapshot.projectsAuto === true
          ? [
              {
                value: "auto",
                label: "Auto",
                hint: project.auto === true ? "on · Clankie works the backlog unprompted" : "off",
              },
              { value: "focus", label: "Focus", hint: project.focus ?? "none" },
            ]
          : []),
        { value: "name", label: "Name", hint: project.name },
        {
          value: "roles",
          label: "Hire roles…",
          hint: project.roles.length ? project.roles.map((r) => r.role).join(", ") : "built-ins",
        },
        { value: "cap", label: "Worker cap", hint: project.workerCap?.toString() ?? "none" },
        ...(project.workspaces.length
          ? [
              {
                value: "tracker",
                label: "Tracker",
                hint: project.trackerRef ? `on · ${project.trackerRef.path}` : "off",
              },
            ]
          : []),
        {
          value: "workspaces",
          label: "Workspaces…",
          hint: `${project.workspaces.length}${project.worktreeRoots.length ? ` · ${project.worktreeRoots.length} worktree roots` : ""}`,
        },
      ],
      allowBack: true,
    });
    if (choice === undefined) return;
    if (choice === "roles") await services.roles(id);
    else if (choice === "workspaces") await workspaces(flow, services, project);
    else if (choice === "name") {
      const name = await flow.readText({
        message: "Display name",
        defaultValue: project.name,
        allowBack: true,
      });
      if (name?.trim() && name.trim() !== project.name)
        await update({ name: name.trim() }, `Renamed to ${name.trim()}.`);
    } else if (choice === "cap") {
      const cap = await flow.readText({
        message: "Worker cap (empty clears it)",
        ...(project.workerCap === undefined ? {} : { defaultValue: String(project.workerCap) }),
        allowBack: true,
        validate: (value) =>
          value.trim() === "" || /^\d{1,4}$/u.test(value.trim()) ? undefined : "Enter a whole number.",
      });
      if (cap !== undefined)
        await update(
          { workerCap: cap.trim() === "" ? null : Number(cap.trim()) },
          cap.trim() === "" ? "Worker cap cleared." : `Worker cap ${cap.trim()}.`,
        );
    } else if (choice === "auto") {
      await update(
        { auto: project.auto !== true },
        project.auto === true ? "Auto off: no new work starts on this project." : "Auto on.",
      );
    } else if (choice === "focus") {
      const focus = await flow.readText({
        message: "What matters now (one line; empty clears it)",
        ...(project.focus === undefined ? {} : { defaultValue: project.focus }),
        allowBack: true,
        validate: (value) => (value.trim().length <= 280 ? undefined : "Keep it to 280 characters."),
      });
      if (focus !== undefined && focus.trim() !== (project.focus ?? ""))
        await update(
          { focus: focus.trim() === "" ? null : focus.trim() },
          focus.trim() === "" ? "Focus cleared." : "Focus saved.",
        );
    } else if (choice === "tracker") {
      const workspace = project.workspaces[0]!;
      await update(
        {
          trackerRef: project.trackerRef
            ? null
            : { workspaceId: workspace.id, path: ".clankie/tracking.json" },
        },
        project.trackerRef ? "Tracker unbound." : "Tracker bound.",
      );
    }
  }
}

async function workspaces(flow: SetupFlow, services: ProjectsMenuServices, project: Project) {
  const choice = await flow.readSelect({
    message: `${project.name} · workspaces`,
    options: [
      ...project.workspaces.map((workspace) => ({
        value: `workspace:${workspace.id}`,
        label: home(workspace.path),
        hint: `${workspace.id}${workspace.machineId === "local" ? "" : ` · ${workspace.machineId}`}`,
      })),
      ...project.worktreeRoots.map((root) => ({
        value: `root:${root.id}`,
        label: home(root.path),
        hint: `worktree root · ${home(root.repoPath)}`,
      })),
      { value: "add", label: "Add a workspace…", hint: "a folder on this machine" },
    ],
    allowBack: true,
  });
  if (choice === undefined || choice.startsWith("root:")) return;
  if (choice === "add") {
    const path = await flow.readText({
      message: "Workspace folder (absolute path)",
      ...(services.cwd === undefined ? {} : { defaultValue: services.cwd }),
      allowBack: true,
      validate: (value) => (value.trim().startsWith("/") ? undefined : "Use an absolute path."),
    });
    if (path?.trim())
      await attempt(
        flow,
        () => services.workspace(["add", project.id, "--workspace", path.trim()]),
        `Added ${home(path.trim())}.`,
      );
    return;
  }
  const workspace = project.workspaces.find((entry) => `workspace:${entry.id}` === choice);
  if (!workspace) return;
  const confirm = await flow.readSelect({
    message: `Remove ${home(workspace.path)} from ${project.name}?`,
    options: [
      { value: "no", label: "Keep it" },
      { value: "yes", label: "Remove", hint: "files stay on disk" },
    ],
    allowBack: true,
  });
  if (confirm !== "yes") return;
  const remote =
    workspace.machineId === "local"
      ? []
      : ["--machine", workspace.machineId, "--platform", workspace.platform];
  await attempt(
    flow,
    () => services.workspace(["remove-workspace", project.id, "--workspace", workspace.path, ...remote]),
    `Removed ${home(workspace.path)}.`,
  );
}
