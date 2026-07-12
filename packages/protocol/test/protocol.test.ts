import { describe, expect, it } from "vitest";
import {
  ApprovalDecisionInputSchema,
  ApprovalEventSchema,
  ApprovalRequestRecordSchema,
  assertValidDag,
  CaptainPresenceEventSchema,
  CaptainPresenceReportSchema,
  CaptainLaneSchema,
  CharacterSnapshotSchema,
  IntentCommandSchema,
  MissionPlanSchema,
  TrackerNarrativeActionSchema,
  TrackerNarrativeWriteSchema,
  WorkerStatusEventSchema,
} from "../src/index.ts";

describe("protocol", () => {
  it("exposes exactly the five policy-classified tracker narrative actions", () => {
    expect(TrackerNarrativeActionSchema.options).toEqual([
      "tracker.comment.create",
      "tracker.agent-activity.thought.create",
      "tracker.agent-activity.response.create",
      "tracker.agent-activity.elicitation.create",
      "tracker.reaction.create",
    ]);
    expect(() =>
      TrackerNarrativeWriteSchema.parse({
        schemaVersion: 1,
        idempotencyKey: "delivery:escape",
        action: "tracker.priority.update",
        identity: {
          missionId: "mission-linear",
          taskId: "task-linear",
          workerRunId: "worker-linear",
          correlationId: "linear-delivery:test",
          profileHash: "profile-linear",
          workspaceId: "workspace-linear",
          appUserId: "app-linear",
        },
        issueId: "issue-linear",
        agentSessionId: "session-linear",
        content: "Must remain denied.",
      }),
    ).toThrow();
  });

  it("validates pending and decided approval records and semantic events", () => {
    const pending = ApprovalRequestRecordSchema.parse({
      id: "approval-1",
      missionId: "mission-1",
      taskId: "verify",
      workerRunId: "worker-1",
      action: "github.pr.merge",
      resource: { type: "pull_request", id: "example/repo#1" },
      rationale: {
        effect: "require_approval",
        reason: "Human approval is required.",
        matchedPolicyIds: ["invariant-floor:human-approval"],
      },
      requestedAt: "2026-07-11T21:00:00.000Z",
      status: "pending",
      correlationId: "correlation-1",
      profileHash: "profile-1",
    });
    expect(
      ApprovalEventSchema.parse({
        id: "event-1",
        occurredAt: pending.requestedAt,
        missionId: pending.missionId,
        taskId: pending.taskId,
        workerRunId: pending.workerRunId,
        correlationId: pending.correlationId,
        profileHash: pending.profileHash,
        type: "approval.requested",
        data: { approval: pending },
      }).data.approval,
    ).toEqual(pending);
    expect(() => ApprovalRequestRecordSchema.parse({ ...pending, status: "approved" })).toThrow();
    const approved = ApprovalRequestRecordSchema.parse({
      ...pending,
      status: "approved",
      decidedAt: "2026-07-11T21:01:00.000Z",
      decidedBy: "operator-james",
      reason: "Reviewed the evidence.",
    });
    expect(
      ApprovalEventSchema.parse({
        id: "event-2",
        occurredAt: "2026-07-11T21:02:00.000Z",
        missionId: approved.missionId,
        taskId: approved.taskId,
        workerRunId: approved.workerRunId,
        correlationId: approved.correlationId,
        profileHash: approved.profileHash,
        type: "approval.decided",
        data: {
          approval: approved,
          consumedAt: "2026-07-11T21:02:00.000Z",
          consumedBy: "worker-1",
        },
      }).data.approval.status,
    ).toBe("approved");
    expect(ApprovalDecisionInputSchema.parse({ decision: "deny", reason: " Unsafe " })).toEqual({
      decision: "deny",
      reason: "Unsafe",
    });
  });

  it("accepts a valid mission plan", () => {
    const plan = MissionPlanSchema.parse({
      missionId: "m1",
      goal: "Build the proof",
      rationale: "Exercise orchestration",
      profileHash: "hash",
      successCriteria: ["all checks pass"],
      tasks: [
        {
          id: "implement",
          title: "Implement",
          objective: "Write code",
          kind: "implementation",
          role: "implementer",
          successCriteria: ["file exists"],
          evidenceRequirements: ["A diff and passing unit test are attached."],
          estimatedDurationMinutes: 10,
          estimatedCostUsd: 0.25,
        },
        {
          id: "verify",
          title: "Verify",
          objective: "Run tests",
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          successCriteria: ["tests pass"],
          evidenceRequirements: ["The unchanged test command and exit code are recorded."],
        },
      ],
      plannedActions: [
        {
          id: "merge-change",
          taskId: "verify",
          action: "merge_pull_request",
          resource: { type: "pull_request", id: "example/repo#1" },
          rationale: "Integrate the independently verified change.",
        },
      ],
    });

    expect(() => assertValidDag(plan.tasks)).not.toThrow();
    expect(plan.tasks[0]).toMatchObject({
      role: "implementer",
      evidenceRequirements: ["A diff and passing unit test are attached."],
      estimatedDurationMinutes: 10,
      estimatedCostUsd: 0.25,
    });
    expect(plan.plannedActions[0]?.action).toBe("merge_pull_request");
  });

  it("rejects cycles", () => {
    expect(() =>
      assertValidDag([
        {
          id: "a",
          title: "A",
          objective: "A",
          kind: "implementation",
          role: "implementer",
          dependsOn: ["b"],
          executionClass: "automatic",
          risk: "low",
          writeScope: [],
          successCriteria: ["done"],
          evidenceRequirements: ["A diff is attached."],
          maxAttempts: 1,
          metadata: {},
        },
        {
          id: "b",
          title: "B",
          objective: "B",
          kind: "verification",
          role: "verifier",
          dependsOn: ["a"],
          executionClass: "automatic",
          risk: "low",
          writeScope: [],
          successCriteria: ["done"],
          evidenceRequirements: ["The test result is attached."],
          maxAttempts: 1,
          metadata: {},
        },
      ]),
    ).toThrow(/cycle/);
  });

  it("rejects tasks without an evidence contract", () => {
    expect(() =>
      MissionPlanSchema.parse({
        missionId: "m2",
        goal: "Build",
        rationale: "Prove the task contract",
        profileHash: "hash",
        successCriteria: ["done"],
        tasks: [
          {
            id: "implement",
            title: "Implement",
            objective: "Write code",
            kind: "implementation",
            role: "implementer",
            successCriteria: ["code exists"],
          },
        ],
      }),
    ).toThrow(/evidenceRequirements/);
  });

  it("rejects planned actions that reference unknown tasks", () => {
    expect(() =>
      MissionPlanSchema.parse({
        missionId: "m3",
        goal: "Build",
        rationale: "Prove action references",
        profileHash: "hash",
        successCriteria: ["done"],
        tasks: [
          {
            id: "implement",
            title: "Implement",
            objective: "Write code",
            kind: "implementation",
            role: "implementer",
            successCriteria: ["code exists"],
            evidenceRequirements: ["A diff is attached."],
          },
        ],
        plannedActions: [
          {
            id: "merge",
            taskId: "missing",
            action: "merge_pull_request",
            resource: { type: "pull_request", id: "example/repo#1" },
            rationale: "Integrate the change.",
          },
        ],
      }),
    ).toThrow(/unknown task/);
  });

  it("validates a versioned character snapshot and lane-bound intent", () => {
    expect(
      CharacterSnapshotSchema.parse({
        schemaVersion: 1,
        characterId: "clankie",
        goalVersion: 7,
        activeWorldId: "private-paper-world",
        activeEnvironmentSessionId: "minecraft-session-1",
        activeMissionId: "m-minecraft",
        goal: { kind: "collect", summary: "Collect oak logs" },
        activeActionId: "action-1",
        updatedAt: "2026-07-11T12:00:00.000Z",
      }),
    ).toMatchObject({ goalVersion: 7, sharedMemoryRefs: [] });

    expect(
      IntentCommandSchema.parse({
        schemaVersion: 1,
        intentId: "intent-8",
        characterId: "clankie",
        context: {
          sourceLane: "tui",
          authority: {
            principal: { kind: "human", id: "james" },
            tier: "authenticated",
          },
          correlationId: "corr-8",
          expectedGoalVersion: 7,
        },
        type: "set_goal",
        goal: { kind: "return", summary: "Return to spawn" },
        createdAt: "2026-07-11T12:00:01.000Z",
      }),
    ).toMatchObject({ type: "set_goal" });
  });

  it("rejects unknown captain lanes and intents without concurrency guards", () => {
    expect(() => CaptainLaneSchema.parse("global")).toThrow();
    expect(() =>
      IntentCommandSchema.parse({
        schemaVersion: 1,
        intentId: "intent-unsafe",
        characterId: "clankie",
        context: {
          sourceLane: "gameplay",
          authority: {
            principal: { kind: "captain", id: "clankie" },
            tier: "autonomous",
          },
          correlationId: "corr-unsafe",
        },
        type: "steer",
        createdAt: "2026-07-11T12:00:01.000Z",
      }),
    ).toThrow(/expectedGoalVersion/);
  });

  it("binds missions and tasks to the same gameplay world contract", () => {
    const binding = {
      schemaVersion: 1 as const,
      environmentKind: "minecraft_java",
      characterId: "clankie",
      worldId: "private-paper-world",
      lane: "gameplay" as const,
    };
    const parsed = MissionPlanSchema.parse({
      missionId: "minecraft-mission",
      goal: "Play Minecraft",
      rationale: "Exercise an interactive environment",
      profileHash: "profile-hash",
      successCriteria: ["Paper verifies the outcome"],
      environmentBindings: [binding],
      tasks: [
        {
          id: "play",
          title: "Play",
          objective: "Complete the bounded goal",
          kind: "implementation",
          role: "implementer",
          successCriteria: ["goal complete"],
          evidenceRequirements: ["server-state proof"],
          environmentBinding: binding,
        },
      ],
    });

    expect(parsed.tasks[0]?.environmentBinding).toEqual(binding);
    expect(parsed.environmentBindings).toEqual([binding]);
  });

  it("rejects a task environment binding outside its mission world", () => {
    expect(() =>
      MissionPlanSchema.parse({
        missionId: "minecraft-mission",
        goal: "Play Minecraft",
        rationale: "Exercise an interactive environment",
        profileHash: "profile-hash",
        successCriteria: ["goal complete"],
        environmentBindings: [
          {
            schemaVersion: 1,
            environmentKind: "minecraft_java",
            characterId: "clankie",
            worldId: "allowed-world",
            lane: "gameplay",
          },
        ],
        tasks: [
          {
            id: "play",
            title: "Play",
            objective: "Complete the bounded goal",
            kind: "implementation",
            role: "implementer",
            successCriteria: ["goal complete"],
            evidenceRequirements: ["server-state proof"],
            environmentBinding: {
              schemaVersion: 1,
              environmentKind: "minecraft_java",
              characterId: "clankie",
              worldId: "other-world",
              lane: "gameplay",
            },
          },
        ],
      }),
    ).toThrow(/not declared by the mission/);
  });

  it("validates additive worker status events with provenance", () => {
    expect(
      WorkerStatusEventSchema.parse({
        id: "status-1",
        occurredAt: "2026-07-11T12:00:00.000Z",
        missionId: "mission-1",
        taskId: "task-1",
        workerRunId: "run-1",
        correlationId: "correlation-1",
        profileHash: "profile-1",
        type: "worker.waiting_user",
        data: {
          state: "waiting_user",
          source: "codex.app_server",
          tier: 0,
          confidence: 1,
          observedAt: "2026-07-11T12:00:00.000Z",
          questionSummary: "Approve the requested command?",
        },
      }),
    ).toMatchObject({ type: "worker.waiting_user", data: { tier: 0, confidence: 1 } });

    expect(() =>
      WorkerStatusEventSchema.parse({
        id: "status-2",
        occurredAt: "2026-07-11T12:00:00.000Z",
        missionId: "mission-1",
        taskId: "task-1",
        workerRunId: "run-1",
        correlationId: "correlation-1",
        profileHash: "profile-1",
        type: "worker.turn.settled",
        data: { state: "idle", source: "pi.rpc", tier: 0, confidence: 1 },
      }),
    ).toThrow(/observedAt/);
  });

  it("validates additive captain-domain presence and lifecycle events", () => {
    const base = {
      id: "captain-status-1",
      occurredAt: "2026-07-11T12:00:00.000Z",
      missionId: "captain-presence",
      correlationId: "captain-generation-1",
      profileHash: "profile-1",
    };
    expect(
      CaptainPresenceEventSchema.parse({
        ...base,
        type: "captain.turn.started",
        data: {
          schemaVersion: 1,
          subjectId: "captain",
          captainId: "captain-eve",
          leaseId: "lease-1",
          generationId: "generation-1",
          sessionId: "session-1",
          turnId: "turn-1",
          state: "working",
          tier: 0,
          source: "eve.lifecycle",
          confidence: 1,
          observedAt: "2026-07-11T12:00:00.000Z",
        },
      }),
    ).toMatchObject({ type: "captain.turn.started", data: { state: "working", tier: 0 } });

    expect(
      CaptainPresenceReportSchema.parse({
        schemaVersion: 1,
        eventId: "input-1",
        leaseId: "lease-1",
        generationId: "generation-1",
        occurredAt: "2026-07-11T12:00:01.000Z",
        type: "captain.turn.settled",
        sessionId: "session-1",
        turnId: "turn-1",
        state: "waiting_user",
        questionSummary: "Approve the requested action?",
      }),
    ).toMatchObject({ type: "captain.turn.settled", state: "waiting_user" });

    expect(() =>
      CaptainPresenceReportSchema.parse({
        schemaVersion: 1,
        eventId: "forged-offline",
        leaseId: "lease-1",
        generationId: "generation-1",
        occurredAt: "2026-07-11T12:00:02.000Z",
        type: "captain.presence.offline",
      }),
    ).toThrow();
  });
});
