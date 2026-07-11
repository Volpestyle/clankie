import { describe, expect, it } from "vitest";
import {
  assertValidDag,
  CaptainLaneSchema,
  CharacterSnapshotSchema,
  IntentCommandSchema,
  MissionPlanSchema,
} from "../src/index.ts";

describe("protocol", () => {
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
});
