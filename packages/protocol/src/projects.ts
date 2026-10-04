import { z } from "zod";
import { OPERATOR_SEAT_HARNESSES } from "./seat-harnesses.ts";
import { OPERATOR_AGENT_ROLES, OperatorAgentRoleSchema, operatorAgentRoleKey } from "./agent-roles.ts";

export const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const RefSchema = z.string().trim().min(1).max(200);
export const DEFAULT_PROJECT_ID = "default";
/** These are owner settings, not evidence that a caller occupies an approved workspace. */
export const ProjectWorkspaceSchema = z
  .object({
    id: ProjectIdSchema,
    machineId: RefSchema,
    path: z.string().min(1).max(4096),
    platform: z.enum(["posix", "windows"]),
  })
  .strict();
/** Dedicated namespace for linked worktrees; never ordinary path-containment authority. */
export const ProjectWorktreeRootSchema = ProjectWorkspaceSchema.extend({
  repoPath: z.string().min(1).max(4096),
  commonDirectory: z.string().min(1).max(4096),
}).strict();
export type ProjectWorktreeRoot = z.infer<typeof ProjectWorktreeRootSchema>;
export const ProjectRoleSchema = z
  .object({
    role: OperatorAgentRoleSchema,
    harness: z.enum(OPERATOR_SEAT_HARNESSES).optional(),
    model: RefSchema.optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    concurrencyCap: z.number().int().min(0).max(1000).optional(),
    hireNaming: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
/** Empty or omitted project roles inherit the built-ins without persisting overrides (ADR 0216). */
export function projectRolePolicy(
  project: Pick<Project, "roles">,
  role: string,
): z.infer<typeof ProjectRoleSchema> | undefined {
  const key = operatorAgentRoleKey(role);
  if (project.roles.length === 0 && OPERATOR_AGENT_ROLES.some((builtIn) => builtIn === key))
    return { role: key };
  return project.roles.find((entry) => operatorAgentRoleKey(entry.role) === key);
}
/** References constrain later grants; these records cannot replace broker/link/account checks. */
export const ProjectGrantRuleSchema = z
  .object({
    id: ProjectIdSchema,
    server: RefSchema,
    accountId: RefSchema,
    tools: z
      .array(
        z
          .object({
            name: RefSchema,
            arguments: z.record(z.string(), z.json()).default({}),
            forbiddenArguments: z.array(RefSchema).max(64).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();
export const ProjectSchema = z
  .object({
    id: ProjectIdSchema,
    name: z.string().trim().min(1).max(100),
    workspaces: z.array(ProjectWorkspaceSchema).max(256).default([]),
    worktreeRoots: z.array(ProjectWorktreeRootSchema).max(32).default([]),
    trackerRef: z
      .object({ workspaceId: ProjectIdSchema, path: z.literal(".clankie/tracking.json") })
      .strict()
      .optional(),
    roles: z.array(ProjectRoleSchema).max(256).default([]),
    workerCap: z.number().int().min(0).max(1000).optional(),
    fleet: z
      .object({
        size: z.enum(["max", "large", "small", "solo"]).optional(),
        models: z.enum(["optimal", "efficient"]).optional(),
      })
      .strict()
      .optional(),
    labelRoleMap: z
      .array(z.object({ label: RefSchema, role: OperatorAgentRoleSchema }).strict())
      .max(256)
      .default([]),
    grants: z.array(ProjectGrantRuleSchema).max(256).default([]),
  })
  .strict()
  .superRefine((project, ctx) => {
    const unique = (values: string[], message: string) => {
      if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", message });
    };
    unique(
      project.workspaces.map((w) => w.id),
      "Workspace IDs must be unique",
    );
    unique(
      project.worktreeRoots.map((root) => root.id),
      "Worktree root IDs must be unique",
    );
    unique(
      project.roles.map((r) => operatorAgentRoleKey(r.role)),
      "Role keys must be unique",
    );
    unique(
      project.grants.map((g) => g.id),
      "Grant rule IDs must be unique",
    );
    unique(
      project.labelRoleMap.map((m) => m.label),
      "Tracker labels must be unique",
    );
    if (project.trackerRef && !project.workspaces.some((w) => w.id === project.trackerRef?.workspaceId))
      ctx.addIssue({ code: "custom", message: "Tracker workspace must belong to the project" });
    for (const mapping of project.labelRoleMap)
      if (projectRolePolicy(project, mapping.role) === undefined)
        ctx.addIssue({ code: "custom", message: "Tracker role must belong to the project" });
  });
/** Semantic association only. Never use this record as proof of a live hire or pane's membership. */
export const ProjectRoleAssignmentSchema = z
  .object({
    projectId: ProjectIdSchema,
    personaId: RefSchema,
    role: OperatorAgentRoleSchema,
  })
  .strict();
const LegacyRoleSchema = z.object({ personaId: RefSchema, role: OperatorAgentRoleSchema }).strict();
export const ProjectsSettingsSchema = z
  .object({
    projects: z.array(ProjectSchema).max(256).default([]),
    assignments: z.array(ProjectRoleAssignmentSchema).max(10_000).default([]),
    roleWriteReceipts: z
      .array(
        z
          .object({
            sourceId: z.string().regex(/^[a-f0-9]{64}$/u),
            operationIds: z.array(z.string().uuid()).max(10_000),
          })
          .strict(),
      )
      .max(256)
      .default([]),
    /** Durable receipt allows restart after settings commit but before legacy identity cleanup. */
    legacyRoleMigration: z
      .object({ sourceId: z.string().regex(/^[a-f0-9]{64}$/u), roles: z.array(LegacyRoleSchema).max(10_000) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.projects.map((p) => p.id)).size !== value.projects.length)
      ctx.addIssue({ code: "custom", message: "Project IDs must be unique" });
    if (
      new Set(value.assignments.map((a) => `${a.projectId}\0${a.personaId}`)).size !==
      value.assignments.length
    )
      ctx.addIssue({ code: "custom", message: "One role per persona per project" });
    for (const assignment of value.assignments)
      if (
        !value.projects.some(
          (p) => p.id === assignment.projectId && projectRolePolicy(p, assignment.role) !== undefined,
        )
      )
        ctx.addIssue({ code: "custom", message: "Assignment must reference an existing project role" });
    if (
      value.legacyRoleMigration &&
      new Set(value.legacyRoleMigration.roles.map((r) => r.personaId)).size !==
        value.legacyRoleMigration.roles.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate migrated persona" });
  });
export const SetProjectRoleAssignmentSchema = z
  .object({
    projectId: ProjectIdSchema,
    personaId: RefSchema,
    role: OperatorAgentRoleSchema.nullable(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const ProjectsSnapshotSchema = z
  .object({ settings: ProjectsSettingsSchema, revision: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectWorkspace = z.infer<typeof ProjectWorkspaceSchema>;
export type ProjectsSettings = z.infer<typeof ProjectsSettingsSchema>;
export type ProjectRoleAssignment = z.infer<typeof ProjectRoleAssignmentSchema>;
/** Descriptive result only: the host must establish every input from its current occupant and canonical filesystem. */
export const ProjectMembershipSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("member"),
      projectId: ProjectIdSchema,
      source: z.enum(["hire", "workspace"]),
      role: OperatorAgentRoleSchema.optional(),
    })
    .strict(),
  z
    .object({ outcome: z.enum(["unassigned", "ambiguous", "invalid_assignment", "unverified_workspace"]) })
    .strict(),
]);
export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>;

export const PROJECTS_PATH = "/v1/operator/projects";
export const PROJECT_UPDATE_SETTINGS_PATH = "/v1/operator/projects/update";
export const PROJECT_CREATE_SETTINGS_PATH = "/v1/operator/projects/create";
/** Owner-confirmed NEW local project only. No remote enrollment or runtime authority. */
export const CreateProjectSettingsSchema = z
  .object({
    projectId: ProjectIdSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    name: z.string().trim().min(1).max(100),
    workspacePath: z.string().min(1).max(4096),
    roles: z
      .array(
        ProjectRoleSchema.extend({
          concurrencyCap: ProjectRoleSchema.shape.concurrencyCap.unwrap().nullable().optional(),
        }).strict(),
      )
      .max(256)
      .optional(),
    workerCap: z.number().int().min(0).max(1000).nullable().optional(),
    trackerRef: z
      .object({ workspaceId: z.literal("primary"), path: z.literal(".clankie/tracking.json") })
      .strict()
      .nullable()
      .optional(),
    /** Preference only; neither field implies or changes a numeric hire cap. */
    fleet: z
      .object({
        size: z.enum(["max", "large", "small", "solo"]).optional(),
        models: z.enum(["optimal", "efficient"]).optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type CreateProjectSettings = z.infer<typeof CreateProjectSettingsSchema>;

/** Omitted fields stay unchanged; null removes an optional limit or tracker binding. */
export const UpdateProjectSettingsSchema = z
  .object({
    projectId: ProjectIdSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    changes: z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        roles: z.array(ProjectRoleSchema).max(256).optional(),
        workerCap: z.number().int().min(0).max(1000).nullable().optional(),
        trackerRef: z
          .object({ workspaceId: ProjectIdSchema, path: z.literal(".clankie/tracking.json") })
          .strict()
          .nullable()
          .optional(),
      })
      .strict()
      .refine(
        (value) => Object.values(value).some((field) => field !== undefined),
        "No project changes supplied",
      ),
  })
  .strict();
export type UpdateProjectSettings = z.infer<typeof UpdateProjectSettingsSchema>;
export type ProjectsSnapshot = z.infer<typeof ProjectsSnapshotSchema>;
export const PROJECT_REMOVE_WORKSPACE_PATH = "/v1/operator/projects/remove-workspace";
export const RemoveProjectWorkspaceSchema = z
  .object({
    projectId: ProjectIdSchema,
    workspaceId: ProjectIdSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const PROJECT_ADD_WORKTREE_ROOT_PATH = "/v1/operator/projects/add-worktree-root";
export const PROJECT_REMOVE_WORKTREE_ROOT_PATH = "/v1/operator/projects/remove-worktree-root";
export const AddProjectWorktreeRootSchema = z
  .object({
    projectId: ProjectIdSchema,
    machineId: RefSchema,
    platform: z.enum(["posix", "windows"]),
    path: z.string().min(1).max(4096),
    repoPath: z.string().min(1).max(4096),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const RemoveProjectWorktreeRootSchema = z
  .object({
    projectId: ProjectIdSchema,
    rootId: ProjectIdSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

/** Read-only owner diagnostic. Host eligibility never proves a bridge socket or tool catalog. */
export interface FleetPaneMembership {
  pane: string;
  harness: string;
  harnessSource: "herdr-inventory";
  cwd?: string;
  nativeSession: "observed" | "pending" | "unavailable";
  hire: "none" | "assigned" | "invalid" | "unobserved";
  eligibility: "eligible" | "unsupported" | "unproven" | "stale" | "private-unbound" | "ineligible";
  reason: string;
  projectId?: string;
}
export interface FleetMembershipReport {
  machine: string;
  observedAt: string;
  evidence: "host-process";
  nativeTools: "not-verified";
  totalPanes: number;
  truncated: boolean;
  panes: FleetPaneMembership[];
}
