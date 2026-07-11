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
          successCriteria: ["file exists"],
        },
        {
          id: "verify",
          title: "Verify",
          objective: "Run tests",
          kind: "verification",
          dependsOn: ["implement"],
          successCriteria: ["tests pass"],
        },
      ],
    });

    expect(() => assertValidDag(plan.tasks)).not.toThrow();
  });

  it("rejects cycles", () => {
    expect(() =>
      assertValidDag([
        {
          id: "a",
          title: "A",
          objective: "A",
          kind: "implementation",
          dependsOn: ["b"],
          executionClass: "automatic",
          risk: "low",
          writeScope: [],
          successCriteria: ["done"],
          maxAttempts: 1,
          metadata: {},
        },
        {
          id: "b",
          title: "B",
          objective: "B",
          kind: "verification",
          dependsOn: ["a"],
          executionClass: "automatic",
          risk: "low",
          writeScope: [],
          successCriteria: ["done"],
          maxAttempts: 1,
          metadata: {},
        },
      ]),
    ).toThrow(/cycle/);
  });
});
