import { realpath } from "node:fs/promises";
import { resolveProjectMembership } from "@clankie/settings";
import type { ProjectsSettings } from "@clankie/protocol/projects";

/** The service's local machine ID is `local` (machines.ts); a fleet label is not a machine identity. */
export async function localWorkspaceProject(
  settings: ProjectsSettings,
  directory: string,
): Promise<string | undefined> {
  const canonicalPath = await realpath(directory);
  for (const project of settings.projects)
    for (const workspace of project.workspaces)
      if (
        workspace.machineId === "local" &&
        workspace.platform === "posix" &&
        (await realpath(workspace.path)) !== workspace.path
      )
        throw new Error("A project's workspace path has changed. Check its approved folder before hiring.");
  const membership = resolveProjectMembership(settings, {
    occupantId: "workspace-selection",
    workspace: { machineId: "local", canonicalPath, platform: "posix" },
  });
  if (membership.outcome === "member") return membership.projectId;
  if (membership.outcome === "unassigned") return undefined;
  throw new Error(
    "This folder belongs to more than one project. Check its project workspaces before hiring.",
  );
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
