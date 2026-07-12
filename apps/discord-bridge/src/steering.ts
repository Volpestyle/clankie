import {
  activeWorkerRunId,
  MissionIdentityMismatchError,
  projectBoundMissionRecord,
  sanitizeDiscordText,
} from "./mission-state.ts";
import type { WorkerSteerIntent } from "@clankie/api-client";
import type { MissionThreadRegistry } from "./thread-registry.ts";

export interface MissionSteeringApi {
  getMission(missionId: string): Promise<Record<string, unknown>>;
  steerWorker(workerRunId: string, intent: WorkerSteerIntent): Promise<{ accepted: boolean }>;
}

export const DISCORD_WORKER_STEER_CHOICES = [
  {
    name: "Focus on the current task",
    value: "focus_current_task",
    intent: { type: "focus", target: "current_task" },
  },
  {
    name: "Focus on the failing test",
    value: "focus_failing_test",
    intent: { type: "focus", target: "failing_test" },
  },
  {
    name: "Focus on acceptance criteria",
    value: "focus_acceptance_criteria",
    intent: { type: "focus", target: "acceptance_criteria" },
  },
  { name: "Focus on declared scope", value: "focus_scope", intent: { type: "focus", target: "scope" } },
  { name: "Focus on diagnosis", value: "focus_diagnosis", intent: { type: "focus", target: "diagnosis" } },
  { name: "Continue the current task", value: "continue", intent: { type: "continue" } },
  { name: "Retry the last failed step", value: "retry_last_step", intent: { type: "retry_last_step" } },
  { name: "Summarize current status", value: "summarize_status", intent: { type: "summarize_status" } },
] as const satisfies ReadonlyArray<{ name: string; value: string; intent: WorkerSteerIntent }>;

export function workerSteerIntentForDiscordChoice(value: string): WorkerSteerIntent | undefined {
  const choice = DISCORD_WORKER_STEER_CHOICES.find((candidate) => candidate.value === value);
  return choice ? structuredClone(choice.intent) : undefined;
}

export type MissionSteeringResult =
  | { status: "thread_not_bound" }
  | { status: "no_active_worker"; missionId: string }
  | { status: "mission_snapshot_mismatch"; missionId: string }
  | { status: "control_plane_refused"; missionId: string; workerRunId: string; httpStatus: number }
  | { status: "issued"; missionId: string; workerRunId: string; accepted: boolean };

export async function issueMissionSteering(
  registry: MissionThreadRegistry,
  api: MissionSteeringApi,
  threadId: string,
  intent: WorkerSteerIntent,
  guildId?: string,
): Promise<MissionSteeringResult> {
  const missionId = registry.missionId(threadId, guildId);
  if (!missionId) return { status: "thread_not_bound" };

  let mission;
  try {
    mission = projectBoundMissionRecord(await api.getMission(missionId), missionId);
  } catch (error) {
    if (error instanceof MissionIdentityMismatchError) {
      return { status: "mission_snapshot_mismatch", missionId };
    }
    throw error;
  }
  const workerRunId = activeWorkerRunId(mission);
  if (!workerRunId) return { status: "no_active_worker", missionId };

  try {
    const response = await api.steerWorker(workerRunId, intent);
    return { status: "issued", missionId, workerRunId, accepted: response.accepted };
  } catch (error) {
    const httpStatus = clankieApiStatus(error);
    if (httpStatus && [400, 401, 403, 409, 503].includes(httpStatus)) {
      return { status: "control_plane_refused", missionId, workerRunId, httpStatus };
    }
    throw error;
  }
}

export function renderMissionSteeringReply(result: MissionSteeringResult): string {
  if (result.status === "thread_not_bound") {
    return "The mission thread binding changed before steering was issued.";
  }
  if (result.status === "no_active_worker") {
    return "No active worker run is currently available for steering.";
  }
  if (result.status === "mission_snapshot_mismatch") {
    return "Steering was refused because the control-plane snapshot did not match this thread's mission binding.";
  }
  if (result.status === "control_plane_refused") {
    return `Steering was refused by the control plane for worker run **${sanitizeDiscordText(result.workerRunId)}** (HTTP ${result.httpStatus}).`;
  }
  return result.accepted
    ? `Steering accepted for worker run **${sanitizeDiscordText(result.workerRunId)}**.`
    : `Steering was refused for worker run **${sanitizeDiscordText(result.workerRunId)}**.`;
}

function clankieApiStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /^Clankie API (\d{3}):/.exec(error.message);
  return match?.[1] ? Number(match[1]) : undefined;
}
