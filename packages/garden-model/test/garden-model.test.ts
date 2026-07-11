import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@sapling/protocol";
import { projectGarden } from "../src/index.ts";

const base = {
  occurredAt: new Date().toISOString(),
  missionId: "m1",
  correlationId: "c1",
  profileHash: "p1",
};

describe("garden projection", () => {
  it("moves a failed implementation worker to the recovery shed", () => {
    const events: DomainEvent[] = [
      {
        ...base,
        id: "1",
        type: "worker.started",
        taskId: "implement",
        workerRunId: "run1",
        data: { workerId: "codex-1", harness: "codex", taskKind: "implementation" },
      },
      {
        ...base,
        id: "2",
        type: "task.failed",
        taskId: "implement",
        workerRunId: "run1",
        data: { summary: "Tests failed" },
      },
      {
        ...base,
        id: "3",
        type: "worker.completed",
        taskId: "implement",
        workerRunId: "run1",
        data: { result: "failed" },
      },
    ];
    const world = projectGarden(events);
    expect(world.agents[0]?.location).toBe("recovery_shed");
    expect(world.agents[0]?.state).toBe("failed");
    expect(world.attentionQueue).toHaveLength(1);
  });

  it("removes resolved failures and completed approvals from live attention", () => {
    const events: DomainEvent[] = [
      {
        ...base,
        id: "1",
        type: "worker.started",
        taskId: "verify",
        workerRunId: "run1",
        data: { workerId: "verifier", harness: "claude", taskKind: "verification" },
      },
      {
        ...base,
        id: "2",
        type: "task.failed",
        taskId: "verify",
        workerRunId: "run1",
        data: { summary: "Tests failed" },
      },
      {
        ...base,
        id: "3",
        type: "approval.requested",
        data: { actionRequestId: "merge-1", summary: "Approve merge" },
      },
      {
        ...base,
        id: "4",
        type: "attention.resolved",
        taskId: "verify",
        data: { reason: "Repair verified" },
      },
      {
        ...base,
        id: "5",
        type: "approval.recorded",
        data: { actionRequestId: "merge-1", decision: "approved" },
      },
    ];
    const world = projectGarden(events);
    expect(world.attentionQueue).toEqual([]);
    expect(world.agents[0]?.state).toBe("failed");
    expect(world.agents[0]?.attention).toBe("none");
  });
});
