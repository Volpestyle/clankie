import { TaskStateSchema, type DomainEvent, type MissionState, type TaskState } from "@clankie/protocol";

/**
 * Mission state rebuilt purely from the event log (ADR 0002). Tasks appear once
 * they emit an event (`task.added` or a lifecycle transition); tasks that never
 * ran are not observable from the log.
 */
export interface MissionProjection {
  missionId: string;
  goal?: string;
  state: MissionState;
  profileHash: string;
  taskStates: Record<string, TaskState>;
  approvalCount: number;
  eventCount: number;
}

export function projectMission(events: readonly DomainEvent[], missionId?: string): MissionProjection {
  const scoped = missionId ? events.filter((event) => event.missionId === missionId) : [...events];
  const first = scoped[0];
  if (!first) throw new Error(`No events found${missionId ? ` for mission ${missionId}` : ""}`);

  const taskStates: Record<string, TaskState> = {};
  let goal: string | undefined;
  let approvalCount = 0;
  let terminal: MissionState | undefined;
  let lastTaskEventIndex = -1;
  let terminalEventIndex = -1;

  for (let index = 0; index < scoped.length; index += 1) {
    const event = scoped[index];
    if (!event) continue;

    if (event.type === "mission.created" && typeof event.data.goal === "string") {
      goal = event.data.goal;
    } else if (event.type === "mission.succeeded" || event.type === "mission.cancelled") {
      terminal = event.type === "mission.succeeded" ? "succeeded" : "cancelled";
      terminalEventIndex = index;
    } else if (event.type === "mission.failed") {
      terminal = "failed";
      terminalEventIndex = index;
    } else if (event.type === "approval.recorded") {
      approvalCount += 1;
    } else if (event.taskId && event.type.startsWith("task.")) {
      const transition = taskTransition(event.type);
      if (transition) {
        taskStates[event.taskId] = transition;
        lastTaskEventIndex = index;
      }
    }
  }

  return {
    missionId: first.missionId,
    ...(goal !== undefined ? { goal } : {}),
    state: resolveMissionState(terminal, terminalEventIndex, lastTaskEventIndex, taskStates),
    profileHash: first.profileHash,
    taskStates,
    approvalCount,
    eventCount: scoped.length,
  };
}

function taskTransition(type: string): TaskState | undefined {
  if (type === "task.added" || type === "task.requeued") return "queued";
  const candidate = TaskStateSchema.safeParse(type.slice("task.".length));
  return candidate.success ? candidate.data : undefined;
}

/**
 * Mirrors MissionEngine state resolution: `succeeded`/`cancelled` are sticky;
 * an explicit `mission.failed` holds unless task activity followed it; otherwise
 * the state is recomputed from the observed task states.
 */
function resolveMissionState(
  terminal: MissionState | undefined,
  terminalEventIndex: number,
  lastTaskEventIndex: number,
  taskStates: Record<string, TaskState>,
): MissionState {
  if (terminal === "succeeded" || terminal === "cancelled") return terminal;
  if (terminal === "failed" && terminalEventIndex > lastTaskEventIndex) return "failed";

  const states = Object.values(taskStates);
  if (states.some((state) => state === "running" || state === "leased")) return "running";
  if (states.some((state) => state === "failed")) return "failed";
  if (states.some((state) => state === "blocked" || state === "waiting_user")) return "blocked";
  if (states.length > 0 && states.every((state) => state === "succeeded")) return "verifying";
  return "running";
}
