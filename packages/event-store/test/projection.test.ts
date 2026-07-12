import type { DomainEvent } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { projectMission } from "../src/index.ts";

function event(
  type: string,
  data: Record<string, unknown> = {},
  extra: Partial<DomainEvent> = {},
  index = 0,
): DomainEvent {
  return {
    id: `e-${type}-${String(index)}`,
    occurredAt: new Date(Date.UTC(2026, 6, 10, 0, 0, index)).toISOString(),
    missionId: "m-1",
    correlationId: "c-1",
    profileHash: "profile-abc",
    type,
    data,
    ...extra,
  };
}

describe("projectMission", () => {
  it("rebuilds mission and task state from a successful run", () => {
    const projection = projectMission([
      event("mission.created", { goal: "Ship it", taskCount: 2 }, {}, 1),
      event("mission.started", { doctrine: "self-build-lab" }, {}, 2),
      event("task.started", { title: "Implement" }, { taskId: "t-impl", workerRunId: "run-1" }, 3),
      event("task.failed", { summary: "Defect" }, { taskId: "t-impl" }, 4),
      event("task.added", { title: "Debug", kind: "debugging" }, { taskId: "t-debug" }, 5),
      event("task.started", { title: "Debug" }, { taskId: "t-debug" }, 6),
      event("task.succeeded", { summary: "Repaired" }, { taskId: "t-debug" }, 7),
      event("task.started", { title: "Implement" }, { taskId: "t-impl" }, 8),
      event("task.succeeded", { summary: "Done" }, { taskId: "t-impl" }, 9),
      event("approval.recorded", { actionRequestId: "a-1", decision: "approved" }, {}, 10),
      event("mission.succeeded", { summary: "Complete" }, {}, 11),
    ]);

    expect(projection).toEqual({
      missionId: "m-1",
      goal: "Ship it",
      state: "succeeded",
      profileHash: "profile-abc",
      taskStates: { "t-impl": "succeeded", "t-debug": "succeeded" },
      approvalCount: 1,
      eventCount: 11,
    });
  });

  it("derives non-terminal mission state from task states", () => {
    const running = projectMission([
      event("mission.created", { goal: "G" }, {}, 1),
      event("task.started", {}, { taskId: "t-1" }, 2),
    ]);
    expect(running.state).toBe("running");

    const blocked = projectMission([
      event("mission.created", { goal: "G" }, {}, 1),
      event("task.blocked", { reason: "no worker" }, { taskId: "t-1" }, 2),
    ]);
    expect(blocked.state).toBe("blocked");

    const verifying = projectMission([
      event("mission.created", { goal: "G" }, {}, 1),
      event("task.succeeded", {}, { taskId: "t-1" }, 2),
    ]);
    expect(verifying.state).toBe("verifying");
  });

  it("holds an explicit mission.failed unless task activity followed it", () => {
    const failed = projectMission([
      event("task.succeeded", {}, { taskId: "t-1" }, 1),
      event("mission.failed", { reason: "budget exceeded" }, {}, 2),
    ]);
    expect(failed.state).toBe("failed");

    const recovered = projectMission([
      event("mission.failed", { reason: "transient" }, {}, 1),
      event("task.added", { title: "Retry" }, { taskId: "t-2" }, 2),
      event("task.started", {}, { taskId: "t-2" }, 3),
    ]);
    expect(recovered.state).toBe("running");
  });

  it("scopes to a single mission when multiple are interleaved", () => {
    const projection = projectMission(
      [
        event("mission.created", { goal: "A" }, {}, 1),
        event("mission.created", { goal: "B" }, { missionId: "m-2" }, 2),
        event("task.started", {}, { taskId: "t-b", missionId: "m-2" }, 3),
        event("mission.succeeded", {}, {}, 4),
      ],
      "m-2",
    );
    expect(projection).toMatchObject({
      missionId: "m-2",
      goal: "B",
      state: "running",
      eventCount: 2,
    });
  });
});
