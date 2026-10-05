import { realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  effectiveFleetAutonomy,
  observeLocalProjectGitWorktree,
  observeLocalProjectWorktreeRoot,
  projectPathContains,
  projectWorktreeMatches,
  resolveProjectMembership,
  type ClankieSettings,
} from "@clankie/settings";
import type { FleetSettingsContextRequest, FleetSettingsContext, HerdrBinding } from "@clankie/protocol";
import type { ExecutionConnections } from "./herdr-session.ts";

export interface FleetSettingsContextDependencies {
  runtimes?: Pick<ExecutionConnections, "list"> | undefined;
  herdrBinding?: (() => HerdrBinding | undefined) | undefined;
}

/** Source policy and linked target are independent; neither observation creates authority. */
export async function resolveFleetSettingsContext(
  settings: ClankieSettings,
  input: FleetSettingsContextRequest,
  dependencies: FleetSettingsContextDependencies,
): Promise<FleetSettingsContext> {
  const cwd = await realpath(input.workingDirectory);
  if (!(await stat(cwd)).isDirectory()) throw new Error("Machine setup requires an existing directory");
  const platform = process.platform === "win32" ? "windows" : "posix";
  const eligible = { ...settings.projects, projects: [] as typeof settings.projects.projects };
  for (const project of settings.projects.projects) {
    const workspaces = [];
    for (const workspace of project.workspaces) {
      if (workspace.machineId !== "local" || workspace.platform !== platform) continue;
      try {
        if ((await realpath(workspace.path)) !== workspace.path)
          throw new Error("An approved project workspace changed its canonical path");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      workspaces.push(workspace);
    }
    eligible.projects.push({ ...project, workspaces });
  }
  const membership = resolveProjectMembership(eligible, {
    occupantId: "machine-setup-context",
    workspace: { machineId: "local", platform, canonicalPath: cwd },
  });
  if (membership.outcome === "ambiguous" || membership.outcome === "unverified_workspace")
    throw new Error("Machine setup project context is ambiguous or unverified");
  const matches = new Set(
    await projectWorktreeMatches(
      settings.projects,
      { machineId: "local", platform, cwd },
      observeLocalProjectWorktreeRoot,
      observeLocalProjectGitWorktree,
    ),
  );
  if (membership.outcome === "member") matches.add(membership.projectId);
  if (matches.size > 1) throw new Error("Machine setup project context is ambiguous");
  const projectId = [...matches][0];
  // A folder in an approved worktree namespace cannot fall back to global
  // policy merely because its current Git registration could not be proven.
  if (
    projectId === undefined &&
    settings.projects.projects.some((project) =>
      project.worktreeRoots.some(
        (root) =>
          root.machineId === "local" &&
          root.platform === platform &&
          projectPathContains(root.path, cwd, platform),
      ),
    )
  )
    throw new Error("Machine setup worktree could not be verified");
  if (input.projectId !== undefined && input.projectId !== projectId)
    throw new Error("The requested setup project does not match the current workspace");
  if ((await realpath(input.workingDirectory)) !== cwd) throw new Error("Machine setup workspace changed");

  const connection = settings.execution.connections.find((entry) => entry.id === input.machine);
  const machineId =
    input.machine === "local" || input.machine === "default"
      ? "local"
      : (connection?.machine ?? input.machine);
  if (machineId !== "local" && !settings.machines.some((machine) => machine.id === machineId))
    throw new Error("Machine setup target is not registered");
  const primary =
    input.machine === "local" || input.machine === "default" ? dependencies.herdrBinding?.() : undefined;
  // Named runtimes identify one exact descriptor. Machine aliases represent
  // their registration set rather than guessing which runtime the owner meant.
  const target = connection ?? {
    machine: settings.machines.find((entry) => entry.id === machineId) ?? { id: machineId },
    connections: settings.execution.connections
      .filter((entry) => entry.machine === machineId)
      .sort((left, right) => left.id.localeCompare(right.id)),
    ...(machineId === "local" ? { primary: primary ?? null } : {}),
  };
  const targetRevision = createHash("sha256").update(JSON.stringify(target)).digest("hex");
  let linked = primary !== undefined;
  if (!linked && dependencies.runtimes) {
    const observed = await dependencies.runtimes.list();
    const ids = connection
      ? [connection.id]
      : settings.execution.connections
          .filter((entry) => entry.machine === machineId)
          .map((entry) => entry.id);
    if (machineId === "local" && input.machine !== "default" && input.machine !== "local" && connection)
      linked = observed.some(
        (runtime) =>
          runtime.id === connection.id &&
          runtime.machine === "local" &&
          runtime.enabled &&
          runtime.state === "healthy",
      );
    else
      linked = observed.some(
        (runtime) =>
          (machineId === "local"
            ? runtime.id === "default" || ids.includes(runtime.id)
            : ids.includes(runtime.id)) &&
          runtime.machine === machineId &&
          runtime.enabled &&
          runtime.state === "healthy",
      );
  }
  if ((await realpath(input.workingDirectory)) !== cwd)
    throw new Error("Machine setup workspace changed while its target was checked");
  const project = settings.projects.projects.find((entry) => entry.id === projectId);
  return {
    schemaVersion: 1,
    effective: effectiveFleetAutonomy(settings.autonomy, project?.autonomy),
    ...(projectId === undefined ? {} : { projectId }),
    machine: { id: machineId, linked, targetRevision },
  };
}
