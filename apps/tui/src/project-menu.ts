/**
 * `/project` as a modal: pick a project, then edit its name, worker cap,
 * tracker, hire roles and workspaces in place. Every read and write goes
 * through the same revision-bearing clients as `clankie project`, so a stale
 * revision is refused here exactly as it is on the CLI.
 */
import {
  ProjectIdSchema,
  ProductPathsSchema,
  ProjectWipCapSchema,
  ProjectOwnerLoopSchema,
  ProjectHiringPolicySchema,
  ProjectsSnapshotSchema,
  type Project,
  type ProjectStatus,
} from "@clankie/protocol/projects";
import { ProjectReviewSchema } from "@clankie/protocol/reviews";
import type { ClankieFaceShell } from "./shell/shell.ts";
import type { SetupFlow } from "./shell/setup-flow.ts";

type Run = (args: readonly string[]) => Promise<unknown>;
export interface ProjectsMenuServices {
  /** `clankie project list|create|update` (runProjectSettingsCommand). */
  readonly settings: Run;
  /** `clankie project add|remove-workspace` (runProjectCommand). */
  readonly workspace: Run;
  readonly roles: (projectId: string) => Promise<void>;
  /** The master Auto switch: reads it, or sets it and returns the new state (ADR 0264). */
  readonly auto?: ((enabled?: boolean) => Promise<boolean>) | undefined;
  readonly cwd?: string;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** A seat ID carries `term_`; anything else names a role (ADR 0287). */
const reviewerChoice = (text: string) =>
  /(?:^|\/)term_/u.test(text.trim()) ? { seat: text.trim() } : { role: text.trim() };
const home = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+/u, "~");

async function attempt(flow: SetupFlow, work: () => Promise<unknown>, done: string): Promise<void> {
  try {
    await work();
    flow.renderLine(done, "success");
  } catch (error) {
    flow.renderLine(message(error), "error");
  }
}

/** `2 working · 3 landed today · 1 needs you`, the project's status line. */
function statusLine(status: ProjectStatus): string {
  return [
    `${status.agentsWorking} working`,
    ...(status.landedToday === undefined ? [] : [`${status.landedToday} landed today`]),
    ...(status.needsYou ? [`${status.needsYou} need${status.needsYou === 1 ? "s" : ""} you`] : []),
  ].join(" · ");
}

/** `id · 3 roles · cap 4 · tracker` — the facts worth seeing before opening a project. */
function projectHint(project: Project, status: ProjectStatus | undefined): string {
  return [
    ...(status === undefined ? [] : [statusLine(status)]),
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
      const auto = await services.auto?.().catch(() => undefined);
      const choice = await flow.readSelect({
        message: [
          projects.length ? `Projects (${projects.length})` : "No projects yet",
          ...(auto === undefined ? [] : [`Auto ${auto ? "on" : "off"}`]),
          ...(snapshot.needsYou
            ? [`${snapshot.needsYou} need${snapshot.needsYou === 1 ? "s" : ""} you`]
            : []),
        ].join(" · "),
        options: [
          ...(auto === undefined
            ? []
            : [
                {
                  value: "auto",
                  label: auto ? "Turn Auto off" : "Turn Auto on",
                  hint: auto ? "Stop all unprompted work" : "Work the projects on Auto without being asked",
                },
              ]),
          ...projects.map((project) => ({
            value: `project:${project.id}`,
            label: project.name,
            hint: projectHint(project, snapshot.projectStatus?.[project.id]),
            ...(project.workspaces[0] ? { description: home(project.workspaces[0].path) } : {}),
          })),
          { value: "create", label: "New project…", hint: "from a local folder" },
        ],
        allowBack: true,
      });
      if (choice === undefined) return;
      if (choice === "auto") {
        await attempt(
          flow,
          () => services.auto!(!auto),
          auto ? "Auto is off: nothing starts unprompted." : "Auto is on.",
        );
        continue;
      }
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
    const choice = await flow.readSelect({
      message: `${project.name} · ${project.id}`,
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
        ...(snapshot.productPaths === true
          ? [
              {
                value: "product-paths",
                label: "Product paths",
                hint: project.productPaths?.join(", ") ?? "default classification",
              },
            ]
          : []),
        ...(snapshot.projectAutoUpdates === true
          ? [
              {
                value: "auto-updates",
                label: "Automatic project updates",
                hint: project.autoUpdates === false ? "off" : "on (default)",
              },
            ]
          : []),
        ...(snapshot.projectReview === true
          ? [
              {
                value: "reviewer",
                label: "Reviewer",
                hint:
                  project.review === undefined
                    ? "none · landings need no review"
                    : "seat" in project.review
                      ? `seat ${project.review.seat}`
                      : `role ${project.review.role}`,
              },
            ]
          : []),
        ...(snapshot.projectWorkPolicy === true
          ? [
              { value: "wip-cap", label: "Started issue cap", hint: project.wipCap?.toString() ?? "none" },
              {
                value: "owner-loop",
                label: "Owner reports",
                hint: project.ownerLoop ?? "milestones (default)",
              },
              {
                value: "hiring",
                label: "Hiring defaults and constraints…",
                hint: "lead / worker profiles and eligible plans",
              },
              ...(snapshot.retiredWorkingPreferences?.projects[project.id] === undefined
                ? []
                : [
                    {
                      value: "retired-preferences",
                      label: "Retired preferences (read-only)…",
                      hint: "saved values preserved",
                    },
                  ]),
            ]
          : []),
        {
          value: "tracker-project",
          label: "Built-in tracker project",
          hint: project.trackerProjectId ?? "none",
        },
        ...(snapshot.linearProjectBindings
          ? [
              {
                value: "linear-project",
                label: "Linear project",
                hint: project.linearProjectBinding?.projectId ?? "none",
              },
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
                label: "Workspace tracker",
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
    } else if (choice === "product-paths") {
      const paths = await flow.readText({
        message: "Product paths (JSON list of repository-relative globs; empty restores default)",
        ...(project.productPaths === undefined ? {} : { defaultValue: JSON.stringify(project.productPaths) }),
        allowBack: true,
        validate: (value) => {
          if (value.trim() === "") return undefined;
          try {
            ProductPathsSchema.parse(JSON.parse(value));
            return undefined;
          } catch {
            return "Use a JSON list of 1–32 relative globs, at most 256 characters each, without .. or backslashes.";
          }
        },
      });
      if (paths !== undefined)
        await update(
          { productPaths: paths.trim() === "" ? null : ProductPathsSchema.parse(JSON.parse(paths)) },
          paths.trim() === "" ? "Default product classification restored." : "Product paths saved.",
        );
    } else if (choice === "wip-cap") {
      const value = await flow.readText({
        message: "Maximum started tracker issues (1–1000; empty removes the cap)",
        ...(project.wipCap === undefined ? {} : { defaultValue: String(project.wipCap) }),
        allowBack: true,
        validate: (text) =>
          text.trim() === "" || ProjectWipCapSchema.safeParse(Number(text)).success
            ? undefined
            : "Use an integer from 1 to 1000, or leave empty.",
      });
      if (value !== undefined)
        await update({ wipCap: value.trim() === "" ? null : Number(value) }, "Started issue cap saved.");
    } else if (choice === "auto-updates") {
      const value = await flow.readSelect({
        message: "Post evidence-first updates on noteworthy progress?",
        options: [
          { value: "on", label: "On (default)" },
          { value: "off", label: "Off (existing report cadence)" },
        ],
        currentValue: project.autoUpdates === false ? "off" : "on",
        allowBack: true,
      });
      if (value !== undefined)
        await update({ autoUpdates: value === "on" }, "Automatic project updates saved.");
    } else if (choice === "reviewer") {
      const value = await flow.readText({
        message:
          "Reviewer every landing waits for: a role (such as reviewer) or an exact seat (FLEET/term_…); empty removes it",
        ...(project.review === undefined
          ? {}
          : { defaultValue: "seat" in project.review ? project.review.seat : project.review.role }),
        allowBack: true,
        validate: (text) =>
          text.trim() === "" || ProjectReviewSchema.safeParse(reviewerChoice(text)).success
            ? undefined
            : "Use a role name or a seat ID, or leave empty.",
      });
      if (value !== undefined)
        await update(
          { review: value.trim() === "" ? null : ProjectReviewSchema.parse(reviewerChoice(value)) },
          value.trim() === "" ? "Reviewer removed; landings need no review." : "Reviewer saved.",
        );
    } else if (choice === "owner-loop") {
      const value = await flow.readSelect({
        message: "When should the owner hear project updates?",
        options: [
          { value: "inherit", label: "Default (milestones)" },
          { value: "silent", label: "Silent", hint: "no automatic project status posts" },
          { value: "milestones", label: "Milestones", hint: "one report when a milestone completes" },
          { value: "landings", label: "Landings", hint: "report new default-branch landings" },
        ],
        currentValue: project.ownerLoop ?? "inherit",
        allowBack: true,
      });
      if (value !== undefined)
        await update(
          { ownerLoop: value === "inherit" ? null : ProjectOwnerLoopSchema.parse(value) },
          "Owner report cadence saved.",
        );
    } else if (choice === "hiring") {
      const value = await flow.readText({
        message:
          "Hiring policy (JSON: lead / worker profiles, allowedPlans, excludedPlans, excludedModels; empty inherits)",
        ...(project.hiring === undefined ? {} : { defaultValue: JSON.stringify(project.hiring) }),
        multiline: true,
        allowBack: true,
        validate: (text) => {
          if (!text.trim()) return undefined;
          try {
            ProjectHiringPolicySchema.parse(JSON.parse(text));
            return undefined;
          } catch {
            return "Use valid hiring policy JSON; plan keys look like claude:max_20x or codex:pro.";
          }
        },
      });
      if (value !== undefined)
        await update(
          { hiring: value.trim() === "" ? null : ProjectHiringPolicySchema.parse(JSON.parse(value)) },
          "Hiring policy saved.",
        );
    } else if (choice === "retired-preferences") {
      flow.renderLine(
        `Retired controls; these exact saved values are preserved read-only: ${JSON.stringify(snapshot.retiredWorkingPreferences?.projects[project.id])}`,
        "info",
      );
    } else if (choice === "tracker-project") {
      const projectId = await flow.readText({
        message: "Built-in tracker project UUID (empty clears it)",
        ...(project.trackerProjectId ? { defaultValue: project.trackerProjectId } : {}),
        allowBack: true,
        validate: (value) =>
          value.trim() === "" ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.trim())
            ? undefined
            : "Enter the project’s UUID.",
      });
      if (projectId !== undefined && projectId.trim() !== (project.trackerProjectId ?? ""))
        await update(
          { trackerProjectId: projectId.trim() === "" ? null : projectId.trim() },
          projectId.trim() === "" ? "Built-in tracker project cleared." : "Built-in tracker project bound.",
        );
    } else if (choice === "linear-project") {
      const projectId = await flow.readText({
        message: "Linear project UUID (empty clears it)",
        ...(project.linearProjectBinding ? { defaultValue: project.linearProjectBinding.projectId } : {}),
        allowBack: true,
        validate: (value) =>
          value.trim() === "" ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.trim())
            ? undefined
            : "Enter the project's UUID.",
      });
      if (projectId !== undefined)
        await update(
          {
            linearProjectBinding:
              projectId.trim() === "" ? null : { provider: "linear", projectId: projectId.trim() },
          },
          projectId.trim() === "" ? "Linear project cleared." : "Linear project bound.",
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
