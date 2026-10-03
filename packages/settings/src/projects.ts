import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import {
  DEFAULT_PROJECT_ID,
  ProjectsSettingsSchema,
  ProjectSchema,
  type ProjectsSettings,
  type ProjectMembership,
} from "@clankie/protocol/projects";
import { OperatorAgentRoleSchema, operatorAgentRoleKey } from "@clankie/protocol";

export function projectsRevision(settings: ProjectsSettings): string {
  return createHash("sha256")
    .update(JSON.stringify(ProjectsSettingsSchema.parse(settings)))
    .digest("hex");
}

/** Retains exact legacy role spelling and associations; migration creates no workspace or grant. */
export function migratePersonaRoles(
  settings: ProjectsSettings,
  sourceId: string,
  legacy: readonly { personaId: string; role: string }[],
): ProjectsSettings {
  const roles = legacy
    .map((entry) => ({ personaId: entry.personaId, role: OperatorAgentRoleSchema.parse(entry.role) }))
    .sort((a, b) => a.personaId.localeCompare(b.personaId));
  if (roles.length === 0) return settings;
  const receipt = settings.legacyRoleMigration;
  if (receipt) {
    if (receipt.sourceId !== sourceId || JSON.stringify(receipt.roles) !== JSON.stringify(roles))
      throw new Error("Legacy role migration conflicts with the saved source");
    // The operator may have changed assignments after the original commit. Never resurrect them.
    return settings;
  }
  if (settings.projects.some((project) => project.id === DEFAULT_PROJECT_ID))
    throw new Error("Default project already exists; legacy roles were retained");
  const unique = new Map(roles.map((entry) => [operatorAgentRoleKey(entry.role), { role: entry.role }]));
  const project = ProjectSchema.parse({
    id: DEFAULT_PROJECT_ID,
    name: "Default",
    roles: [...unique.values()],
  });
  return ProjectsSettingsSchema.parse({
    ...settings,
    projects: [...settings.projects, project],
    assignments: [
      ...settings.assignments,
      ...roles.map((entry) => ({ projectId: DEFAULT_PROJECT_ID, ...entry })),
    ],
    legacyRoleMigration: { sourceId, roles },
  });
}

/** Existing role setter compatibility. This associates a character; it does not admit a hire. */
export function setDefaultProjectRole(
  settings: ProjectsSettings,
  personaId: string,
  role: string | null,
): ProjectsSettings {
  const next = structuredClone(settings);
  let project = next.projects.find((p) => p.id === DEFAULT_PROJECT_ID);
  if (!project) {
    project = ProjectSchema.parse({ id: DEFAULT_PROJECT_ID, name: "Default" });
    next.projects.push(project);
  }
  const parsed = role === null ? null : OperatorAgentRoleSchema.parse(role);
  next.assignments = next.assignments.filter(
    (a) => a.projectId !== DEFAULT_PROJECT_ID || a.personaId !== personaId,
  );
  if (parsed !== null) {
    if (!project.roles.some((r) => operatorAgentRoleKey(r.role) === operatorAgentRoleKey(parsed)))
      project.roles.push({ role: parsed });
    next.assignments.push({ projectId: DEFAULT_PROJECT_ID, personaId, role: parsed });
  }
  return ProjectsSettingsSchema.parse(next);
}

/** Default is an explicit compatibility context; never choose an arbitrary assignment. */
export function projectRoleForPersona(
  settings: ProjectsSettings,
  personaId: string,
  projectId = DEFAULT_PROJECT_ID,
): string | undefined {
  return settings.assignments.find((a) => a.projectId === projectId && a.personaId === personaId)?.role;
}

export interface HostProjectHireAssignment {
  readonly projectId: string;
  readonly role?: string;
  /** Must match the current host-observed agent occupant, not merely a persona/session. */
  readonly occupantId: string;
}
export interface HostProjectWorkspace {
  readonly machineId: string;
  readonly canonicalPath: string;
  readonly platform: "posix" | "windows";
}
/**
 * Policy selection, not authorization. Only the host may supply current occupant,
 * explicit durable hire, and freshly resolved real pane cwd. Imported claims do not prove them.
 */
export function resolveProjectMembership(
  settings: ProjectsSettings,
  input: { occupantId: string; hire?: HostProjectHireAssignment; workspace?: HostProjectWorkspace },
): ProjectMembership {
  if (input.hire) {
    const project = settings.projects.find((p) => p.id === input.hire?.projectId);
    if (
      input.hire.occupantId !== input.occupantId ||
      !project ||
      (input.hire.role !== undefined &&
        !project.roles.some((r) => operatorAgentRoleKey(r.role) === operatorAgentRoleKey(input.hire!.role!)))
    )
      return { outcome: "invalid_assignment" };
    return {
      outcome: "member",
      projectId: project.id,
      source: "hire",
      ...(input.hire.role === undefined ? {} : { role: input.hire.role }),
    };
  }
  const workspace = input.workspace;
  if (!workspace) return { outcome: "unverified_workspace" };
  const paths = workspace.platform === "windows" ? win32 : posix;
  const canonical = (path: string) =>
    paths.isAbsolute(path) && paths.normalize(path) === path && !path.includes("\0");
  if (!canonical(workspace.canonicalPath)) return { outcome: "unverified_workspace" };
  const matches = settings.projects.filter((project) =>
    project.workspaces.some((approved) => {
      if (
        approved.machineId !== workspace.machineId ||
        approved.platform !== workspace.platform ||
        !canonical(approved.path)
      )
        return false;
      // Case-sensitive exact owner spelling on both platforms: case/alias uncertainty denies.
      if (workspace.canonicalPath === approved.path) return true;
      return workspace.canonicalPath.startsWith(
        approved.path.endsWith(paths.sep) ? approved.path : approved.path + paths.sep,
      );
    }),
  );
  if (matches.length > 1) return { outcome: "ambiguous" };
  const project = matches[0];
  return project
    ? { outcome: "member", projectId: project.id, source: "workspace" }
    : { outcome: "unassigned" };
}
