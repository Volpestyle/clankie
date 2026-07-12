import type { MissionPlan, TaskSpec } from "@clankie/protocol";

export type MissionPlanValidationIssueCode =
  | "cycle"
  | "duplicate_task_id"
  | "parallel_write_scope_overlap"
  | "self_verification"
  | "debugger_role_mismatch"
  | "unknown_dependency";

export interface MissionPlanValidationIssue {
  code: MissionPlanValidationIssueCode;
  message: string;
  taskIds: string[];
  writeScopes?: string[];
}

export interface MissionPlanValidationEvidence {
  valid: boolean;
  missionId: string;
  taskCount: number;
  assumptions: string[];
  risks: string[];
  humanDecisionsRequired: string[];
  plannedActionIds: string[];
  issues: MissionPlanValidationIssue[];
}

export class MissionPlanValidationError extends Error {
  public readonly evidence: MissionPlanValidationEvidence;

  public constructor(evidence: MissionPlanValidationEvidence) {
    super(formatValidationError(evidence));
    this.name = "MissionPlanValidationError";
    this.evidence = structuredClone(evidence);
  }
}

/**
 * Validate the execution invariants that are intentionally stricter than the
 * protocol's wire-format schema. The result contains no timestamps or runtime
 * identifiers, so the same plan always produces the same evidence.
 */
export function validateMissionPlan(plan: MissionPlan): MissionPlanValidationEvidence {
  const issues = [
    ...findDuplicateTaskIds(plan.tasks),
    ...findUnknownDependencies(plan.tasks),
    ...findCycles(plan.tasks),
    ...findParallelWriteScopeOverlaps(plan.tasks),
    ...findSelfVerification(plan.tasks),
    ...findDebuggerRoleMismatches(plan.tasks),
  ].sort(compareIssues);

  return {
    valid: issues.length === 0,
    missionId: plan.missionId,
    taskCount: plan.tasks.length,
    assumptions: [...plan.assumptions],
    risks: [...plan.risks],
    humanDecisionsRequired: [...plan.humanDecisionsRequired],
    plannedActionIds: plan.plannedActions.map((action) => action.id).sort(),
    issues,
  };
}

export function assertValidMissionPlan(plan: MissionPlan): MissionPlanValidationEvidence {
  const evidence = validateMissionPlan(plan);
  if (!evidence.valid) throw new MissionPlanValidationError(evidence);
  return evidence;
}

function findDuplicateTaskIds(tasks: readonly TaskSpec[]): MissionPlanValidationIssue[] {
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([taskId]) => ({
      code: "duplicate_task_id" as const,
      message: `Task id "${taskId}" is duplicated; give every task a unique id.`,
      taskIds: [taskId],
    }));
}

function findUnknownDependencies(tasks: readonly TaskSpec[]): MissionPlanValidationIssue[] {
  const taskIds = new Set(tasks.map((task) => task.id));
  const issues: MissionPlanValidationIssue[] = [];
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (taskIds.has(dependency)) continue;
      issues.push({
        code: "unknown_dependency",
        message: `Task "${task.id}" depends on unknown task "${dependency}"; add the task or remove the dependency.`,
        taskIds: [task.id, dependency],
      });
    }
  }
  return issues;
}

function findCycles(tasks: readonly TaskSpec[]): MissionPlanValidationIssue[] {
  const taskById = new Map([...tasks].sort(compareTasks).map((task) => [task.id, task]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();

  const visit = (taskId: string): void => {
    if (active.has(taskId)) {
      const cycleStart = stack.indexOf(taskId);
      const cycle = canonicalCycle(stack.slice(cycleStart));
      cycles.set(cycle.join("\0"), cycle);
      return;
    }
    if (visited.has(taskId)) return;
    const task = taskById.get(taskId);
    if (!task) return;

    active.add(taskId);
    stack.push(taskId);
    for (const dependency of [...task.dependsOn].sort()) visit(dependency);
    stack.pop();
    active.delete(taskId);
    visited.add(taskId);
  };

  for (const taskId of [...taskById.keys()].sort()) visit(taskId);
  return [...cycles.values()].map((cycle) => ({
    code: "cycle",
    message: `Task dependency cycle ${[...cycle, cycle[0]].join(" -> ")}; remove or reverse a dependency.`,
    taskIds: cycle,
  }));
}

function findParallelWriteScopeOverlaps(tasks: readonly TaskSpec[]): MissionPlanValidationIssue[] {
  const sortedTasks = [...tasks].sort(compareTasks);
  const taskById = new Map(sortedTasks.map((task) => [task.id, task]));
  const issues: MissionPlanValidationIssue[] = [];

  for (const [index, left] of sortedTasks.entries()) {
    for (const right of sortedTasks.slice(index + 1)) {
      if (isOrdered(left.id, right.id, taskById) || isOrdered(right.id, left.id, taskById)) continue;
      const overlaps = findScopeOverlaps(left.writeScope, right.writeScope);
      if (overlaps.length === 0) continue;
      issues.push({
        code: "parallel_write_scope_overlap",
        message: `Parallel tasks "${left.id}" and "${right.id}" have overlapping write scopes (${overlaps.join(", ")}); make the scopes disjoint or add a dependency.`,
        taskIds: [left.id, right.id],
        writeScopes: overlaps,
      });
    }
  }
  return issues;
}

function findSelfVerification(tasks: readonly TaskSpec[]): MissionPlanValidationIssue[] {
  const issues: MissionPlanValidationIssue[] = [];
  for (const task of [...tasks].sort(compareTasks)) {
    if (task.kind === "verification" && task.role !== "verifier") {
      issues.push({
        code: "self_verification",
        message: `Verification task "${task.id}" uses role "${task.role}"; assign it the independent verifier role.`,
        taskIds: [task.id],
      });
    }
    if (task.role === "verifier" && task.kind !== "verification") {
      issues.push({
        code: "self_verification",
        message: `Verifier task "${task.id}" uses kind "${task.kind}"; use verification so independent worker routing is enforced.`,
        taskIds: [task.id],
      });
    }
    if (task.kind === "verification" && task.writeScope.length > 0) {
      issues.push({
        code: "self_verification",
        message: `Verification task "${task.id}" has write scope (${task.writeScope.join(", ")}); verification must be read-only.`,
        taskIds: [task.id],
        writeScopes: [...task.writeScope].sort(),
      });
    }
  }
  return issues;
}

function findDebuggerRoleMismatches(tasks: readonly TaskSpec[]): MissionPlanValidationIssue[] {
  return [...tasks]
    .sort(compareTasks)
    .filter((task) => task.kind === "debugging" && task.role !== "debugger")
    .map((task) => ({
      code: "debugger_role_mismatch" as const,
      message: `Debugger task "${task.id}" uses role "${task.role}"; assign it the debugger role so failure evidence is routed to a repair worker.`,
      taskIds: [task.id],
    }));
}

function isOrdered(
  taskId: string,
  possibleDependencyId: string,
  taskById: ReadonlyMap<string, TaskSpec>,
): boolean {
  const pending = [...(taskById.get(taskId)?.dependsOn ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (!dependency || visited.has(dependency)) continue;
    if (dependency === possibleDependencyId) return true;
    visited.add(dependency);
    pending.push(...(taskById.get(dependency)?.dependsOn ?? []));
  }
  return false;
}

function findScopeOverlaps(leftScopes: readonly string[], rightScopes: readonly string[]): string[] {
  const overlaps = new Set<string>();
  for (const left of leftScopes) {
    for (const right of rightScopes) {
      if (scopePatternsOverlap(left, right)) overlaps.add(`${left} <> ${right}`);
    }
  }
  return [...overlaps].sort();
}

function scopePatternsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeScope(left);
  const normalizedRight = normalizeScope(right);
  if (normalizedLeft === normalizedRight) return true;

  const leftHasPattern = hasPatternSyntax(normalizedLeft);
  const rightHasPattern = hasPatternSyntax(normalizedRight);
  if (!leftHasPattern && !rightHasPattern) return false;

  const leftRoot = staticDirectoryRoot(normalizedLeft);
  const rightRoot = staticDirectoryRoot(normalizedRight);
  if (leftRoot === "" || rightRoot === "") return true;
  return isWithin(leftRoot, rightRoot) || isWithin(rightRoot, leftRoot);
}

function normalizeScope(scope: string): string {
  return scope
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/^\/+|\/+$/gu, "");
}

function hasPatternSyntax(scope: string): boolean {
  return /[*?[\]{}]/u.test(scope);
}

function staticDirectoryRoot(scope: string): string {
  const firstPattern = scope.search(/[*?[\]{}]/u);
  if (firstPattern === -1) return scope;
  const staticPrefix = scope.slice(0, firstPattern);
  return staticPrefix.slice(0, Math.max(0, staticPrefix.lastIndexOf("/")));
}

function isWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function canonicalCycle(cycle: string[]): string[] {
  if (cycle.length < 2) return cycle;
  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
  rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return rotations[0] ?? cycle;
}

function compareTasks(left: TaskSpec, right: TaskSpec): number {
  return left.id.localeCompare(right.id);
}

function compareIssues(left: MissionPlanValidationIssue, right: MissionPlanValidationIssue): number {
  return (
    left.code.localeCompare(right.code) ||
    left.taskIds.join("\0").localeCompare(right.taskIds.join("\0")) ||
    left.message.localeCompare(right.message)
  );
}

function formatValidationError(evidence: MissionPlanValidationEvidence): string {
  const details = evidence.issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; ");
  return `Mission plan "${evidence.missionId}" failed validation: ${details}`;
}
