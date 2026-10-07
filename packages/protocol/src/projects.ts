import { z } from "zod";
import { FleetGatesSchema } from "./fleet-gates.ts";
import { HireProfileSchema, HireEffortSchema, withoutNoPreference } from "./hire-profile.ts";
import { OPERATOR_AGENT_ROLES, OperatorAgentRoleSchema, operatorAgentRoleKey } from "./agent-roles.ts";
import {
  AutonomySettingsWireSchema,
  FleetWorkingPreferencesSchema,
  ProjectAutonomySchema,
  ProjectAutonomyPatchSchema,
} from "./autonomy.ts";
import type { WorkerBridgeStatus } from "./index.ts";
import { WorkInitSettingsSchema } from "./work-items.ts";

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
    ...HireProfileSchema.shape,
    effort: HireEffortSchema.optional(),
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
    autonomy: ProjectAutonomySchema.optional(),
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
  .object({
    settings: ProjectsSettingsSchema,
    hireDefaults: HireProfileSchema.optional(),
    /** Included only by clients opting into the autonomy-aware project view. */
    autonomyDefaults: AutonomySettingsWireSchema.optional(),
    /** Included by the current service only in the autonomy-aware project view. */
    workingPreferences: z.literal(true).optional(),
    fleetGates: z.literal(true).optional(),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .refine((value) => value.fleetGates !== true || FleetGatesSchema.strip().safeParse(value.autonomyDefaults?.fleet).success, "A fleet-gates project snapshot must include every global gate")
  .refine(
    (value) =>
      value.workingPreferences !== true ||
      FleetWorkingPreferencesSchema.strip().safeParse(value.autonomyDefaults?.fleet).success,
    "A working-preferences project snapshot must include every global preference",
  );
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
        z.preprocess(
          withoutNoPreference,
          ProjectRoleSchema.extend({
            concurrencyCap: ProjectRoleSchema.shape.concurrencyCap.unwrap().nullable().optional(),
          }).strict(),
        ),
      )
      .max(256)
      .optional(),
    workerCap: z.number().int().min(0).max(1000).nullable().optional(),
    trackerRef: z
      .object({ workspaceId: z.literal("primary"), path: z.literal(".clankie/tracking.json") })
      .strict()
      .nullable()
      .optional(),
    /** Creates a missing convention with work init only after explicit CREATE. */
    trackerSetup: WorkInitSettingsSchema.extend({
      backend: WorkInitSettingsSchema.shape.backend.unwrap(),
    }).optional(),
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

/** Proposal data is untrusted; only the separate owner confirmation can apply it. */
export const ProjectProposalDraftSchema = CreateProjectSettingsSchema.omit({
  workspacePath: true,
  expectedRevision: true,
})
  .extend({
    prompt: z.string().trim().min(1).max(2000),
    evidence: z.array(z.string().max(500)).max(8).default([]),
  })
  .strict();
export type ProjectProposalDraft = z.infer<typeof ProjectProposalDraftSchema>;
export const ProjectProposalLocatorSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
    incarnationId: z.string().uuid(),
    requestId: z.string().uuid(),
  })
  .strict();
export type ProjectProposalLocator = z.infer<typeof ProjectProposalLocatorSchema>;
export const ProjectProposalTargetSchema = ProjectProposalLocatorSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
  proposalId: z.string().uuid(),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedProjectsRevision: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type ProjectProposalTarget = z.infer<typeof ProjectProposalTargetSchema>;
/** One reviewed field at a time; a tweak is never acceptance. */
export const ProjectProposalTweakSchema = ProjectProposalTargetSchema.extend({
  change: z.discriminatedUnion("field", [
    z.object({ field: z.literal("name"), value: CreateProjectSettingsSchema.shape.name }).strict(),
    z.object({ field: z.literal("roles"), value: CreateProjectSettingsSchema.shape.roles.unwrap() }).strict(),
    z
      .object({ field: z.literal("workerCap"), value: CreateProjectSettingsSchema.shape.workerCap.unwrap() })
      .strict(),
    z.object({ field: z.literal("fleet"), value: CreateProjectSettingsSchema.shape.fleet.unwrap() }).strict(),
    z
      .object({
        field: z.literal("tracker"),
        value: z
          .object({
            trackerRef: CreateProjectSettingsSchema.shape.trackerRef,
            trackerSetup: CreateProjectSettingsSchema.shape.trackerSetup,
          })
          .strict(),
      })
      .strict(),
  ]),
}).strict();
export type ProjectProposalTweak = z.infer<typeof ProjectProposalTweakSchema>;
export const ProjectProposalResultSchema = z
  .object({
    status: z.enum(["pending", "committing", "created", "uncertain", "refused"]),
    reason: z.string().max(100).optional(),
    proposal: z
      .object({
        target: ProjectProposalTargetSchema,
        command: CreateProjectSettingsSchema,
        project: ProjectSchema,
        effectiveRoles: z.array(ProjectRoleSchema).max(256),
        evidence: z.array(z.string().max(500)).max(8),
      })
      .strict()
      .optional(),
    receipt: z
      .object({ projectId: ProjectIdSchema, projectsRevision: z.string().regex(/^[a-f0-9]{64}$/u) })
      .strict()
      .optional(),
  })
  .strict();
export type ProjectProposalResult = z.infer<typeof ProjectProposalResultSchema>;

/** Omitted fields stay unchanged; null removes optional policy, including a single autonomy leaf. */
export const UpdateProjectSettingsSchema = z
  .object({
    projectId: ProjectIdSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    changes: z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        /** `auto` model/effort (or subagent model/effort) means no preference: saved unset. */
        roles: z.array(z.preprocess(withoutNoPreference, ProjectRoleSchema)).max(256).optional(),
        workerCap: z.number().int().min(0).max(1000).nullable().optional(),
        autonomy: ProjectAutonomyPatchSchema.optional(),
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
  /** Read-only service bridge observations, independent of host project eligibility. */
  workerTools?: WorkerBridgeStatus;
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

/** Host-verified owner display and semantic role context; never hire, control or tool authority. */
export const FLEET_PROJECT_MEMBERSHIP_PATH = "/v1/operator/fleet-membership/read";
const FleetMembershipSeatSchema = z
  .object({
    seatId: z.string().trim().min(1).max(512),
    occupantId: z.string().trim().min(1).max(512),
    fleet: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/u)
      .optional(),
  })
  .strict();
export const ReadFleetProjectMembershipSchema = z
  .object({
    schemaVersion: z.literal(1),
    seats: z
      .array(FleetMembershipSeatSchema)
      .min(1)
      .max(8)
      .refine(
        (seats) =>
          new Set(seats.map((seat) => JSON.stringify([seat.fleet ?? "default", seat.seatId]))).size ===
          seats.length,
        "Duplicate seat",
      ),
  })
  .strict();
export const FleetProjectMembershipSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectsRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    observedAt: z.iso.datetime(),
    seats: z
      .array(
        FleetMembershipSeatSchema.extend({
          membership: z.discriminatedUnion("outcome", [
            z
              .object({
                outcome: z.literal("member"),
                source: z.enum(["hire", "workspace"]),
                projectId: ProjectIdSchema,
                /** Current saved project role of the host-bound persona, if known. */
                role: OperatorAgentRoleSchema.optional(),
              })
              .strict(),
            z
              .object({
                outcome: z.literal("unknown"),
                reason: z.enum([
                  "no_confirmed_hire",
                  "observation_unavailable",
                  "identity_changed",
                  "invalid_assignment",
                  "unsupported_host",
                  "timeout",
                ]),
              })
              .strict(),
          ]),
        }).strict(),
      )
      .max(8),
  })
  .strict();
export type ReadFleetProjectMembership = z.infer<typeof ReadFleetProjectMembershipSchema>;
export type FleetProjectMembershipSnapshot = z.infer<typeof FleetProjectMembershipSnapshotSchema>;

/** An older host is unavailable, never an empty successful membership projection. */
export async function readFleetProjectMembership(
  request: ReadFleetProjectMembership,
  send: (
    path: string,
    body: ReadFleetProjectMembership,
    signal?: AbortSignal,
  ) => Promise<{ status: number; json(): Promise<unknown> }>,
  signal?: AbortSignal,
): Promise<FleetProjectMembershipSnapshot | undefined> {
  signal?.throwIfAborted();
  const input = ReadFleetProjectMembershipSchema.parse(request);
  const response = await send(FLEET_PROJECT_MEMBERSHIP_PATH, input, signal);
  signal?.throwIfAborted();
  if ([404, 405, 501].includes(response.status)) return undefined;
  if (response.status !== 200) throw new Error(`Membership read refused (${response.status})`);
  const result = FleetProjectMembershipSnapshotSchema.parse(await response.json());
  signal?.throwIfAborted();
  if (
    JSON.stringify(result.seats.map(({ membership: _membership, ...seat }) => seat)) !==
    JSON.stringify(input.seats)
  )
    throw new Error("Membership response does not match the requested seats");
  return result;
}

/** Call with monotonic request age and the CURRENT connection/roster/settings generation.
 * A display receipt is not a lease. Disconnect/unknown callers discard old membership. */
export function fleetProjectMembershipApplies(
  result: FleetProjectMembershipSnapshot | undefined,
  request: ReadFleetProjectMembership,
  current: {
    connected: boolean;
    sameGeneration: boolean;
    projectsRevision: string;
    ageMs: number;
    seats: ReadFleetProjectMembership["seats"];
  },
): boolean {
  return (
    result !== undefined &&
    current.connected &&
    current.sameGeneration &&
    current.ageMs >= 0 &&
    current.ageMs <= 5000 &&
    result.projectsRevision === current.projectsRevision &&
    JSON.stringify(current.seats) === JSON.stringify(request.seats) &&
    JSON.stringify(result.seats.map(({ membership: _membership, ...seat }) => seat)) ===
      JSON.stringify(request.seats)
  );
}
