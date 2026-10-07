import { realpath } from "node:fs/promises";
import { projectPathContains, resolveProjectMembership, type ClankieSettings } from "@clankie/settings";
import type { ProjectsSettings } from "@clankie/protocol/projects";

/** The service's local machine ID is `local` (machines.ts); a fleet label is not a machine identity. */
export async function localWorkspaceProject(
  settings: ProjectsSettings,
  directory: string,
): Promise<string | undefined> {
  const canonicalPath = await realpath(directory);
  const eligible: ProjectsSettings = { ...settings, projects: [] };
  for (const project of settings.projects) {
    const workspaces = [];
    for (const workspace of project.workspaces) {
      if (workspace.machineId === "local" && workspace.platform === "posix") {
        try {
          if ((await realpath(workspace.path)) !== workspace.path)
            throw new Error(
              "A project's workspace path has changed. Check its approved folder before hiring.",
            );
        } catch (error) {
          // A removed approval cannot match; it must not block an existing workspace.
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
      }
      workspaces.push(workspace);
    }
    eligible.projects.push({ ...project, workspaces });
  }
  const membership = resolveProjectMembership(eligible, {
    occupantId: "workspace-selection",
    workspace: { machineId: "local", canonicalPath, platform: "posix" },
  });
  if (membership.outcome === "member") return membership.projectId;
  if (membership.outcome === "unassigned") return undefined;
  throw new Error(
    "This folder belongs to more than one project. Check its project workspaces before hiring.",
  );
}

/**
 * This host cannot canonicalize another machine's paths, so a remote destination is
 * proven only by the owner's registered spelling: a project workspace on the
 * fleet's machine (its machine ID, an alias, or any connection to that machine,
 * since connections to one machine share its filesystem), on its platform, at or
 * under the exact registered path. Returns undefined when nothing registered matches.
 */
export function remoteWorkspaceProject(
  settings: Pick<ClankieSettings, "machines" | "execution">,
  projects: ProjectsSettings,
  fleet: string,
  directory: string,
  requested?: string,
): string | undefined {
  const target = remoteHireMachine(settings, fleet);
  if (target === undefined) return undefined;
  const matches = projects.projects
    .filter((project) =>
      project.workspaces.some(
        (workspace) =>
          target.ids.has(workspace.machineId) &&
          workspace.platform === target.platform &&
          projectPathContains(workspace.path, directory, target.platform),
      ),
    )
    .map((project) => project.id);
  if (requested !== undefined && matches.includes(requested)) return requested;
  if (matches.length > 1)
    throw new Error(
      `${directory} on fleet ${fleet} is registered to more than one project (${matches.join(", ")}). Name the projectId to hire into.`,
    );
  return matches[0];
}

/** The machine a remote fleet reaches, with every ID its project workspaces may be registered under. */
export function remoteHireMachine(
  settings: Pick<ClankieSettings, "machines" | "execution">,
  fleet: string,
):
  | { readonly machine: string; readonly ids: ReadonlySet<string>; readonly platform: "posix" | "windows" }
  | undefined {
  const connection = settings.execution.connections.find((entry) => entry.id === fleet);
  const machine = settings.machines.find((entry) => entry.id === connection?.machine);
  if (connection?.ssh === undefined || machine === undefined) return undefined;
  return {
    machine: machine.id,
    ids: new Set([
      machine.id,
      ...machine.aliases,
      ...settings.execution.connections
        .filter((entry) => entry.machine === machine.id)
        .map((entry) => entry.id),
    ]),
    platform: machine.shell === "powershell" ? "windows" : "posix",
  };
}

export function selectHireProject(
  source: string | undefined,
  destination: string | undefined,
  requested?: string,
): string | undefined {
  if (source !== undefined && destination !== undefined && source !== destination)
    throw new Error(
      "This conversation and the new agent's folder belong to different projects. Hire from the intended project's conversation.",
    );
  const project = source ?? destination;
  if (requested !== undefined && requested !== project)
    throw new Error("The selected project does not match this hiring conversation or workspace.");
  return project;
}

/** Native source attribution shares the service's current-process workspace resolver. */
export async function nativeHireProject(
  settings: ProjectsSettings,
  expectedOccupantId: string | undefined,
  proof: import("./project-hires.ts").ProjectHireProcessProof | undefined,
  lookup: (
    proof: import("./project-hires.ts").ProjectHireProcessProof | undefined,
  ) => import("./project-hires.ts").ProjectHireAssignment,
  workspace:
    | ((proof: import("./project-hires.ts").ProjectHireProcessProof) => Promise<string | undefined>)
    | undefined,
): Promise<string | undefined> {
  const assignment = lookup(proof);
  if (assignment.state === "none" && settings.projects.length === 0) return undefined;
  if (!proof || expectedOccupantId === undefined || proof.nativeOccupantId !== expectedOccupantId)
    throw new Error("The conversation's original agent has changed. Check its project before hiring.");
  if (assignment.state === "invalid")
    throw new Error("The conversation's original agent has changed. Check its project before hiring.");
  if (assignment.state === "assigned") {
    const membership = resolveProjectMembership(settings, {
      occupantId: assignment.occupantId,
      hire: assignment,
    });
    if (membership.outcome !== "member")
      throw new Error("This agent's project or role has changed. Check its project before hiring.");
    return membership.projectId;
  }
  const project = await workspace?.(proof);
  if (project === undefined)
    throw new Error(
      "This agent's current project could not be verified. Hire from a project workspace conversation.",
    );
  return project;
}
