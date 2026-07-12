export interface ProjectedTask {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly workerRunId?: string;
}

export interface ProjectedMission {
  readonly id: string;
  readonly state: string;
  readonly eventCount: number;
  readonly approvalCount: number;
  readonly tasks: readonly ProjectedTask[];
}

export class MissionIdentityMismatchError extends Error {
  public constructor(expectedMissionId: string, actualMissionId: string) {
    super(
      `Mission snapshot identity mismatch: expected ${sanitizeDiscordText(expectedMissionId)}, received ${sanitizeDiscordText(actualMissionId)}`,
    );
    this.name = "MissionIdentityMismatchError";
  }
}

export function projectMissionRecord(record: Record<string, unknown>): ProjectedMission {
  const tasks = Array.isArray(record.tasks) ? record.tasks.map(projectTask).filter(isDefined) : [];
  return {
    id: text(record.id, "unknown"),
    state: text(record.state, "unknown"),
    eventCount: integer(record.eventCount),
    approvalCount: Array.isArray(record.approvals) ? record.approvals.length : 0,
    tasks,
  };
}

export function projectBoundMissionRecord(
  record: Record<string, unknown>,
  expectedMissionId: string,
): ProjectedMission {
  const mission = projectMissionRecord(record);
  if (mission.id !== expectedMissionId) {
    throw new MissionIdentityMismatchError(expectedMissionId, mission.id);
  }
  return mission;
}

export function activeWorkerRunId(mission: ProjectedMission): string | undefined {
  const steerableStates = new Set([
    "leased",
    "running",
    "waiting_dependency",
    "waiting_user",
    "blocked",
    "verifying",
  ]);
  return mission.tasks.find((task) => task.workerRunId !== undefined && steerableStates.has(task.state))
    ?.workerRunId;
}

export function renderMissionSummary(mission: ProjectedMission): string {
  const taskLines = mission.tasks.length
    ? mission.tasks
        .map((task) => `- ${sanitizeDiscordText(task.title)}: **${sanitizeDiscordText(task.state)}**`)
        .join(" · ")
    : "- No task plan has been projected yet.";
  return `Mission **${sanitizeDiscordText(mission.id)}** is **${sanitizeDiscordText(mission.state)}**. ${taskLines}`;
}

export function renderMissionChanges(
  previous: ProjectedMission | undefined,
  current: ProjectedMission,
): readonly string[] {
  if (!previous) return [renderMissionSummary(current)];
  const messages: string[] = [];
  if (previous.state !== current.state) {
    messages.push(
      `Mission **${sanitizeDiscordText(current.id)}** changed from **${sanitizeDiscordText(previous.state)}** to **${sanitizeDiscordText(current.state)}**.`,
    );
  }

  const previousTasks = new Map(previous.tasks.map((task) => [task.id, task]));
  for (const task of current.tasks) {
    const prior = previousTasks.get(task.id);
    if (!prior || prior.state !== task.state) {
      messages.push(
        `Task **${sanitizeDiscordText(task.title)}** is now **${sanitizeDiscordText(task.state)}**.`,
      );
    }
  }
  if (current.approvalCount > previous.approvalCount) {
    messages.push(
      `Mission attention: ${String(current.approvalCount - previous.approvalCount)} new approval request(s). ` +
        "Discord cannot decide them; use `/captain-approval` for an authenticated handoff.",
    );
  }
  return messages;
}

function projectTask(value: unknown): ProjectedTask | undefined {
  if (!isRecord(value)) return undefined;
  const spec = isRecord(value.spec) ? value.spec : undefined;
  const id = text(spec?.id, "");
  if (!id) return undefined;
  const workerRunId = text(value.workerRunId, "");
  return {
    id,
    title: text(spec?.title, id),
    state: text(value.state, "unknown"),
    ...(workerRunId ? { workerRunId } : {}),
  };
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function sanitizeDiscordText(value: string): string {
  return stripControlBytes(value)
    .replaceAll("@", "@\u200b")
    .replaceAll("\\", "\\\\")
    .replace(/[\\*_`~|>]/g, "\\$&")
    .slice(0, 500);
}

export function stripControlBytes(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) as number;
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
    })
    .join("");
}
