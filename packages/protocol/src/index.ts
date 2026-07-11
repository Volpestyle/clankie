import { z } from "zod";

export const MissionIdSchema = z.string().min(1);
export const TaskIdSchema = z.string().min(1);
export const WorkerRunIdSchema = z.string().min(1);

export const RiskSchema = z.enum(["low", "medium", "high", "critical"]);
export type Risk = z.infer<typeof RiskSchema>;

export const TaskKindSchema = z.enum([
  "context",
  "planning",
  "research",
  "design",
  "implementation",
  "debugging",
  "verification",
  "review",
  "integration",
  "deployment",
  "evaluation",
]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskRoleSchema = z.enum([
  "planner",
  "implementer",
  "verifier",
  "reviewer",
  "debugger",
  "evaluator",
]);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

export const ExecutionClassSchema = z.enum([
  "eve_subagent",
  "runner_visible",
  "runner_headless",
  "human_owned",
  "automatic",
]);
export type ExecutionClass = z.infer<typeof ExecutionClassSchema>;

export const HarnessSchema = z.enum(["codex", "claude", "pi", "local", "shell", "simulated"]);
export type Harness = z.infer<typeof HarnessSchema>;

export const TaskStateSchema = z.enum([
  "draft",
  "queued",
  "leased",
  "running",
  "waiting_dependency",
  "waiting_user",
  "blocked",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const MissionStateSchema = z.enum([
  "draft",
  "awaiting_approval",
  "running",
  "blocked",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);
export type MissionState = z.infer<typeof MissionStateSchema>;

export const EvidenceSchema = z.object({
  kind: z.enum(["command", "test_report", "diff", "review", "screenshot", "artifact", "log"]),
  label: z.string().min(1),
  uri: z.string().min(1).optional(),
  summary: z.string().min(1),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const TaskSpecSchema = z.object({
  id: TaskIdSchema,
  title: z.string().min(1),
  objective: z.string().min(1),
  kind: TaskKindSchema,
  role: TaskRoleSchema,
  dependsOn: z.array(TaskIdSchema).default([]),
  preferredHarness: HarnessSchema.optional(),
  executionClass: ExecutionClassSchema.default("automatic"),
  risk: RiskSchema.default("low"),
  writeScope: z.array(z.string()).default([]),
  successCriteria: z.array(z.string().min(1)).min(1),
  evidenceRequirements: z.array(z.string().min(1)).min(1),
  estimatedChangedLines: z.number().int().nonnegative().optional(),
  estimatedDurationMinutes: z.number().int().positive().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  maxAttempts: z.number().int().positive().default(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const ActionResourceSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  repository: z.string().optional(),
  environment: z.string().optional(),
});
export type ActionResource = z.infer<typeof ActionResourceSchema>;

export const PlannedActionSchema = z.object({
  id: z.string().min(1),
  taskId: TaskIdSchema.optional(),
  action: z.string().min(1),
  resource: ActionResourceSchema,
  rationale: z.string().min(1),
});
export type PlannedAction = z.infer<typeof PlannedActionSchema>;

export const MissionPlanSchema = z
  .object({
    missionId: MissionIdSchema,
    goal: z.string().min(1),
    rationale: z.string().min(1),
    tasks: z.array(TaskSpecSchema).min(1),
    successCriteria: z.array(z.string().min(1)).min(1),
    assumptions: z.array(z.string().min(1)).default([]),
    risks: z.array(z.string().min(1)).default([]),
    humanDecisionsRequired: z.array(z.string().min(1)).default([]),
    plannedActions: z.array(PlannedActionSchema).default([]),
    profileHash: z.string().min(1),
  })
  .superRefine((plan, context) => {
    const taskIds = new Set(plan.tasks.map((task) => task.id));
    const actionIds = new Set<string>();
    for (const action of plan.plannedActions) {
      if (actionIds.has(action.id)) {
        context.addIssue({
          code: "custom",
          message: `Planned action id ${action.id} is duplicated`,
          path: ["plannedActions"],
        });
      }
      actionIds.add(action.id);
      if (action.taskId && !taskIds.has(action.taskId)) {
        context.addIssue({
          code: "custom",
          message: `Planned action ${action.id} references unknown task ${action.taskId}`,
          path: ["plannedActions"],
        });
      }
    }
  });
export type MissionPlan = z.infer<typeof MissionPlanSchema>;

export const WorkerResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "blocked"]),
  summary: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  outputs: z.record(z.string(), z.unknown()).default({}),
  diagnosis: z.string().optional(),
});
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export const ActionEffectSchema = z.enum(["allow", "deny", "require_approval"]);
export type ActionEffect = z.infer<typeof ActionEffectSchema>;

export const ActionRequestSchema = z.object({
  id: z.string().min(1),
  principal: z.object({
    kind: z.enum(["captain", "worker", "human", "system"]),
    id: z.string().min(1),
    role: z.string().optional(),
  }),
  action: z.string().min(1),
  resource: ActionResourceSchema,
  context: z.object({
    missionId: MissionIdSchema,
    taskId: TaskIdSchema.optional(),
    risk: RiskSchema,
    checksPassed: z.boolean().optional(),
    humanApprovals: z.number().int().nonnegative().optional(),
    changedLines: z.number().int().nonnegative().optional(),
    changedPaths: z.array(z.string()).optional(),
    costSoFarUsd: z.number().nonnegative().optional(),
    profileHash: z.string().min(1),
  }),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ActionDecisionSchema = z.object({
  effect: ActionEffectSchema,
  reason: z.string().min(1),
  matchedPolicyIds: z.array(z.string()),
  obligations: z.array(z.string()).default([]),
});
export type ActionDecision = z.infer<typeof ActionDecisionSchema>;

const EventBaseSchema = z.object({
  id: z.string().min(1),
  occurredAt: z.string().datetime(),
  missionId: MissionIdSchema,
  taskId: TaskIdSchema.optional(),
  workerRunId: WorkerRunIdSchema.optional(),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  profileHash: z.string().min(1),
});

export const DomainEventSchema = EventBaseSchema.extend({
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const ApprovalRecordSchema = z.object({
  actionRequestId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  decidedBy: z.string().min(1),
  reason: z.string().min(1),
  decidedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export function assertValidDag(tasks: TaskSpec[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) {
    throw new Error("Task ids must be unique");
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Task dependency cycle detected at ${id}`);
    visiting.add(id);
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of tasks) visit(task.id);
}
