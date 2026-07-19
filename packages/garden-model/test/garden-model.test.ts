import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@clankie/protocol";
import { projectGarden, type GardenLocation } from "../src/index.ts";

const gardenLocations: Record<GardenLocation, true> = {
  observatory: true,
  seed_library: true,
  design_pond: true,
  build_grove: true,
  test_greenhouse: true,
  review_pavilion: true,
  merge_gate: true,
  release_harbor: true,
  recovery_shed: true,
  commons: true,
  archive_tree: true,
};

const base = {
  occurredAt: new Date().toISOString(),
  missionId: "m1",
  correlationId: "c1",
  profileHash: "p1",
};

function captainEvent(type: string, data: Record<string, unknown>, index: number): DomainEvent {
  return {
    ...base,
    id: `captain-${String(index)}`,
    occurredAt: new Date(Date.UTC(2026, 6, 11, 12, 0, index)).toISOString(),
    missionId: "captain-presence",
    correlationId: "generation-1",
    type,
    data: {
      schemaVersion: 1,
      subjectId: "captain",
      captainId: "captain-eve",
      leaseId: "lease-1",
      generationId: "generation-1",
      confidence: 1,
      observedAt: new Date(Date.UTC(2026, 6, 11, 12, 0, index)).toISOString(),
      ...data,
    },
  };
}

describe("garden projection", () => {
  it("includes the archive tree in the exhaustive location contract", () => {
    expect(Object.keys(gardenLocations)).toContain("archive_tree");
  });

  it.each([
    ["task.succeeded", { summary: "Implementation verified" }],
    ["worker.completed", { result: "succeeded" }],
  ])("moves completed workers to the archive tree for %s", (type, data) => {
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
        type,
        taskId: "implement",
        workerRunId: "run1",
        data,
      },
    ];

    expect(projectGarden(events).agents[0]).toMatchObject({
      location: "archive_tree",
      state: "completed",
      attention: "none",
    });
  });

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

  it("projects waiting-user attention and clears it when work resumes", () => {
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
        type: "worker.waiting_user",
        taskId: "implement",
        workerRunId: "run1",
        data: {
          state: "waiting_user",
          source: "codex.app_server",
          tier: 0,
          confidence: 1,
          observedAt: base.occurredAt,
          questionSummary: "Approve the scoped command?",
        },
      },
    ];

    const waiting = projectGarden(events);
    expect(waiting.agents[0]).toMatchObject({
      state: "waiting_user",
      attention: "action_required",
      summary: "Approve the scoped command?",
    });
    expect(waiting.attentionQueue).toEqual([
      expect.objectContaining({ workerRunId: "run1", label: "Approve the scoped command?" }),
    ]);

    events.push({
      ...base,
      id: "3",
      type: "worker.turn.started",
      taskId: "implement",
      workerRunId: "run1",
      data: {
        state: "working",
        source: "codex.app_server",
        tier: 0,
        confidence: 1,
        observedAt: base.occurredAt,
      },
    });
    const resumed = projectGarden(events);
    expect(resumed.agents[0]).toMatchObject({ state: "working", attention: "none" });
    expect(resumed.attentionQueue).toEqual([]);
  });

  it("projects dependency waits and settled turns", () => {
    const events: DomainEvent[] = [
      {
        ...base,
        id: "1",
        type: "worker.started",
        taskId: "verify",
        workerRunId: "run1",
        data: { workerId: "claude-1", harness: "claude", taskKind: "verification" },
      },
      {
        ...base,
        id: "2",
        type: "worker.waiting_dependency",
        taskId: "verify",
        workerRunId: "run1",
        data: { summary: "Waiting for implementation evidence" },
      },
    ];

    expect(projectGarden(events).agents[0]).toMatchObject({
      state: "waiting_dependency",
      summary: "Waiting for implementation evidence",
    });

    events.push({
      ...base,
      id: "3",
      type: "worker.turn.settled",
      taskId: "verify",
      workerRunId: "run1",
      data: {
        state: "idle",
        source: "claude.agent_sdk",
        tier: 0,
        confidence: 1,
        observedAt: base.occurredAt,
      },
    });
    expect(projectGarden(events).agents[0]).toMatchObject({ state: "idle", summary: "Turn settled" });
  });

  it("projects captain attention with Tier-0 precedence, expiry, and restart", () => {
    const lease = {
      heartbeatAt: "2026-07-11T12:00:00.000Z",
      expiresAt: "2026-07-11T12:00:30.000Z",
      tier: 1,
      source: "control-plane.captain_lease",
    };
    const turn = {
      sessionId: "session-1",
      turnId: "turn-1",
      tier: 0,
      source: "eve.lifecycle",
    };
    const events = [
      captainEvent("captain.presence.online", { ...lease, state: "idle" }, 0),
      captainEvent("captain.turn.started", { ...turn, state: "working" }, 1),
      captainEvent(
        "captain.turn.settled",
        { ...turn, state: "waiting_user", questionSummary: "Captain asked for operator input" },
        2,
      ),
      captainEvent(
        "captain.heartbeat",
        {
          ...lease,
          state: "idle",
          heartbeatAt: "2026-07-11T12:00:03.000Z",
          expiresAt: "2026-07-11T12:00:33.000Z",
        },
        3,
      ),
    ];
    const waiting = projectGarden(events);
    expect(waiting.agents).toEqual([
      expect.objectContaining({
        id: "agent:captain",
        harness: "eve",
        location: "observatory",
        state: "waiting_user",
        attention: "action_required",
      }),
    ]);
    expect(waiting.attentionQueue).toEqual([
      {
        workerRunId: "captain",
        label: "Captain asked for operator input",
        urgency: "action_required",
      },
    ]);

    events.push(captainEvent("captain.turn.started", { ...turn, state: "working" }, 4));
    expect(projectGarden(events)).toMatchObject({
      agents: [expect.objectContaining({ state: "working", attention: "none" })],
      attentionQueue: [],
    });
    events.push(
      captainEvent("captain.presence.offline", { ...lease, state: "offline", reason: "lease_expired" }, 5),
      captainEvent(
        "captain.heartbeat",
        {
          ...lease,
          state: "idle",
          heartbeatAt: "2026-07-11T12:00:06.000Z",
          expiresAt: "2026-07-11T12:00:36.000Z",
        },
        6,
      ),
    );
    expect(projectGarden(events)).toMatchObject({
      agents: [expect.objectContaining({ state: "offline", attention: "urgent" })],
      attentionQueue: [expect.objectContaining({ label: "Captain heartbeat expired" })],
    });

    events.push(
      captainEvent(
        "captain.presence.online",
        {
          ...lease,
          state: "idle",
          leaseId: "lease-2",
          generationId: "generation-2",
          heartbeatAt: "2026-07-11T12:00:07.000Z",
          expiresAt: "2026-07-11T12:00:37.000Z",
        },
        7,
      ),
    );
    expect(projectGarden(events)).toMatchObject({
      agents: [expect.objectContaining({ state: "idle", attention: "none" })],
      attentionQueue: [],
    });
  });
});
