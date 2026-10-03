import { z } from "zod";
import { OPERATOR_SEAT_HARNESSES } from "./seat-harnesses.ts";
import { OperatorAgentRoleSchema, operatorAgentRoleKey } from "./agent-roles.ts";

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
      if (!project.roles.some((r) => operatorAgentRoleKey(r.role) === operatorAgentRoleKey(mapping.role)))
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
          (p) =>
            p.id === assignment.projectId &&
            p.roles.some((r) => operatorAgentRoleKey(r.role) === operatorAgentRoleKey(assignment.role)),
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
export const PROJECT_REMOVE_WORKSPACE_PATH = "/v1/operator/projects/remove-workspace";
export const RemoveProjectWorkspaceSchema = z
  .object({
    projectId: ProjectIdSchema,
    workspaceId: ProjectIdSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
