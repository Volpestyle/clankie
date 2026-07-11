import { describe, expect, it } from "vitest";
import { assertValidDag, MissionPlanSchema } from "../src/index.ts";

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
});
