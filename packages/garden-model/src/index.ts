import { CaptainPresenceEventSchema, type DomainEvent, type Harness, type TaskKind } from "@clankie/protocol";

export type GardenLocation =
  | "observatory"
  | "seed_library"
  | "design_pond"
  | "build_grove"
  | "test_greenhouse"
  | "review_pavilion"
  | "merge_gate"
  | "release_harbor"
  | "recovery_shed"
  | "commons";

export type AgentVisualState =
  | "idle"
  | "working"
  | "waiting_dependency"
  | "waiting_user"
  | "blocked"
  | "failed"
  | "completed"
  | "offline"
  | "human_controlled";

export interface GardenAgent {
  id: string;
  workerRunId: string;
  workerId: string;
  harness: Harness | "eve" | "unknown";
  taskId?: string;
  taskKind?: TaskKind;
  location: GardenLocation;
  state: AgentVisualState;
  attention: "none" | "info" | "action_required" | "urgent";
  summary: string;
  lastEventAt: string;
}

export interface GardenWorld {
  missionId: string;
  agents: GardenAgent[];
  attentionQueue: Array<{
    workerRunId?: string;
    taskId?: string;
    label: string;
    urgency: GardenAgent["attention"];
  }>;
}

const locationByKind: Record<TaskKind, GardenLocation> = {
  context: "seed_library",
  planning: "observatory",
  research: "seed_library",
  design: "design_pond",
  implementation: "build_grove",
  debugging: "recovery_shed",
  verification: "test_greenhouse",
  review: "review_pavilion",
  integration: "merge_gate",
  deployment: "release_harbor",
  evaluation: "review_pavilion",
};

function harness(value: unknown): GardenAgent["harness"] {
  if (["codex", "claude", "pi", "local", "shell", "simulated"].includes(String(value))) {
    return value as GardenAgent["harness"];
  }
  return "unknown";
}

function kind(value: unknown): TaskKind | undefined {
  const kinds: TaskKind[] = [
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
  ];
  return kinds.includes(value as TaskKind) ? (value as TaskKind) : undefined;
}

export function projectGarden(events: DomainEvent[]): GardenWorld {
  const first = events[0];
  const missionId = first?.missionId ?? "unknown";
  const agents = new Map<string, GardenAgent>();
  const attention = new Map<string, GardenWorld["attentionQueue"][number]>();
  let captainTierZeroGeneration: string | undefined;
  let captainOfflineGeneration: string | undefined;

  for (const event of events) {
    const captainEvent = CaptainPresenceEventSchema.safeParse(event);
    if (captainEvent.success) {
      const statusEvent = captainEvent.data;
      const { data } = statusEvent;
      const captain = agents.get("captain") ?? {
        id: "agent:captain",
        workerRunId: "captain",
        workerId: data.captainId,
        harness: "eve" as const,
        location: "observatory" as const,
        state: "idle" as const,
        attention: "none" as const,
        summary: "Captain online",
        lastEventAt: statusEvent.occurredAt,
      };
      captain.lastEventAt = statusEvent.occurredAt;
      if (statusEvent.type === "captain.presence.online") {
        captainTierZeroGeneration = undefined;
        captainOfflineGeneration = undefined;
        captain.state = "idle";
        captain.attention = "none";
        captain.summary = "Captain online";
        attention.delete("captain");
      } else if (statusEvent.type === "captain.presence.offline") {
        captainTierZeroGeneration = undefined;
        captainOfflineGeneration = data.generationId;
        captain.state = "offline";
        captain.attention = "urgent";
        captain.summary = "Captain offline";
        attention.set("captain", {
          workerRunId: "captain",
          label: "Captain heartbeat expired",
          urgency: "urgent",
        });
      } else if (statusEvent.type === "captain.heartbeat") {
        if (
          captainTierZeroGeneration !== data.generationId &&
          captainOfflineGeneration !== data.generationId
        ) {
          captain.state = "idle";
          captain.attention = "none";
          captain.summary = "Captain online";
          attention.delete("captain");
        }
      } else {
        captainTierZeroGeneration = data.generationId;
        captainOfflineGeneration = undefined;
        if (statusEvent.type === "captain.turn.started") {
          captain.state = "working";
          captain.attention = "none";
          captain.summary = "Captain working";
          attention.delete("captain");
        } else if (statusEvent.type === "captain.waiting_dependency") {
          captain.state = "waiting_dependency";
          captain.attention = "none";
          captain.summary = statusEvent.data.summary;
          attention.delete("captain");
        } else if (statusEvent.data.state === "waiting_user") {
          captain.state = "waiting_user";
          captain.attention = "action_required";
          captain.summary = statusEvent.data.questionSummary;
          attention.set("captain", {
            workerRunId: "captain",
            label: statusEvent.data.questionSummary,
            urgency: "action_required",
          });
        } else {
          captain.state = "idle";
          captain.attention = "none";
          captain.summary = "Captain idle";
          attention.delete("captain");
        }
      }
      agents.set("captain", captain);
      continue;
    }

    if (event.type === "worker.started" && event.workerRunId) {
      const taskKind = kind(event.data.taskKind);
      agents.set(event.workerRunId, {
        id: `agent:${event.workerRunId}`,
        workerRunId: event.workerRunId,
        workerId: String(event.data.workerId ?? "unknown"),
        harness: harness(event.data.harness),
        ...(event.taskId ? { taskId: event.taskId } : {}),
        ...(taskKind ? { taskKind } : {}),
        location: taskKind ? locationByKind[taskKind] : "commons",
        state: "working",
        attention: "none",
        summary: `Started ${taskKind ?? "work"}`,
        lastEventAt: event.occurredAt,
      });
      continue;
    }

    if (event.workerRunId) {
      const agent = agents.get(event.workerRunId);
      if (!agent) continue;
      agent.lastEventAt = event.occurredAt;
      if (event.type === "worker.turn.started") {
        agent.state = "working";
        agent.attention = "none";
        agent.summary = "Working";
        attention.delete(`worker:${agent.workerRunId}`);
      } else if (event.type === "worker.turn.settled") {
        agent.state = "idle";
        agent.attention = "none";
        agent.summary = "Turn settled";
        attention.delete(`worker:${agent.workerRunId}`);
      } else if (event.type === "worker.waiting_user") {
        agent.state = "waiting_user";
        agent.attention = "action_required";
        agent.summary = String(event.data.questionSummary ?? "User input required");
        attention.set(`worker:${agent.workerRunId}`, {
          workerRunId: agent.workerRunId,
          ...(event.taskId ? { taskId: event.taskId } : {}),
          label: agent.summary,
          urgency: "action_required",
        });
      } else if (event.type === "worker.waiting_dependency" || event.type === "task.waiting_dependency") {
        agent.state = "waiting_dependency";
        agent.attention = "none";
        agent.summary = String(event.data.summary ?? "Waiting for a dependency");
      } else if (event.type === "worker.progress") {
        agent.summary = String(event.data.message ?? "Working");
      } else if (event.type === "task.failed" || event.type === "worker.crashed") {
        agent.state = "failed";
        agent.location = "recovery_shed";
        agent.attention = "urgent";
        agent.summary = String(event.data.summary ?? event.data.diagnosis ?? "Task failed");
        attention.set(`worker:${agent.workerRunId}`, {
          workerRunId: agent.workerRunId,
          ...(event.taskId ? { taskId: event.taskId } : {}),
          label: agent.summary,
          urgency: "urgent",
        });
      } else if (event.type === "task.blocked") {
        agent.state = "blocked";
        agent.attention = "action_required";
        agent.summary = String(event.data.reason ?? "Blocked");
        attention.set(`worker:${agent.workerRunId}`, {
          workerRunId: agent.workerRunId,
          ...(event.taskId ? { taskId: event.taskId } : {}),
          label: agent.summary,
          urgency: "action_required",
        });
      } else if (
        event.type === "task.succeeded" ||
        (event.type === "worker.completed" && event.data.result === "succeeded")
      ) {
        agent.state = "completed";
        agent.attention = "none";
        agent.summary = String(event.data.summary ?? "Completed");
      } else if (event.type === "human.takeover.started") {
        agent.state = "human_controlled";
        agent.attention = "info";
      }
    }

    if (event.type === "approval.requested") {
      const actionRequestId = String(event.data.actionRequestId ?? event.id);
      attention.set(`approval:${actionRequestId}`, {
        ...(event.workerRunId ? { workerRunId: event.workerRunId } : {}),
        ...(event.taskId ? { taskId: event.taskId } : {}),
        label: String(event.data.summary ?? "Approval required"),
        urgency: "action_required",
      });
    } else if (event.type === "approval.recorded") {
      attention.delete(`approval:${String(event.data.actionRequestId ?? "")}`);
    } else if (event.type === "attention.resolved") {
      const resolvedWorkerRunId = event.workerRunId ?? String(event.data.workerRunId ?? "");
      const resolvedTaskId = event.taskId ?? String(event.data.taskId ?? "");
      for (const [key, item] of attention) {
        if (
          (resolvedWorkerRunId && item.workerRunId === resolvedWorkerRunId) ||
          (resolvedTaskId && item.taskId === resolvedTaskId)
        ) {
          attention.delete(key);
        }
      }
      for (const agent of agents.values()) {
        if (
          (resolvedWorkerRunId && agent.workerRunId === resolvedWorkerRunId) ||
          (resolvedTaskId && agent.taskId === resolvedTaskId)
        ) {
          agent.attention = "none";
        }
      }
    }
  }

  return {
    missionId,
    agents: [...agents.values()].sort((a, b) => a.workerRunId.localeCompare(b.workerRunId)),
    attentionQueue: [...attention.values()],
  };
}
