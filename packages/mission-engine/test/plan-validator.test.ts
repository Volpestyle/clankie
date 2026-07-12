import { describe, expect, it } from "vitest";
import { MissionPlanSchema, type MissionPlan, type TaskSpec } from "@clankie/protocol";
import { MissionPlanValidationError, assertValidMissionPlan, validateMissionPlan } from "../src/index.ts";

function task(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: `Task ${id}`,
    objective: `Complete ${id}`,
    kind: "implementation",
    role: "implementer",
    dependsOn: [],
    executionClass: "automatic",
    risk: "low",
    writeScope: [],
    successCriteria: [`${id} is complete`],
    evidenceRequirements: [`Evidence for ${id}`],
    maxAttempts: 1,
    metadata: {},
    ...overrides,
  };
}

function plan(tasks: TaskSpec[]): MissionPlan {
  return MissionPlanSchema.parse({
    missionId: "validator-property",
    goal: "validate a generated plan",
    rationale: "exercise deterministic admission invariants",
    profileHash: "profile-hash",
    successCriteria: ["the validator returns deterministic evidence"],
    assumptions: ["task descriptions already passed the protocol schema"],
    risks: ["concurrent writes could corrupt a shared worktree"],
    humanDecisionsRequired: ["approve any declared privileged action"],
    tasks,
  });
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length < 2) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]),
  );
}

describe("mission plan admission validation", () => {
  it("rejects cycles with stable, actionable evidence for every task ordering", () => {
    const tasks = [
      task("alpha", { dependsOn: ["charlie"] }),
      task("bravo", { dependsOn: ["alpha"] }),
      task("charlie", { dependsOn: ["bravo"] }),
    ];

    const results = permutations(tasks).map((ordering) => validateMissionPlan(plan(ordering)));
    for (const result of results) {
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual({
        code: "cycle",
        message: "Task dependency cycle alpha -> charlie -> bravo -> alpha; remove or reverse a dependency.",
        taskIds: ["alpha", "charlie", "bravo"],
      });
      expect(result).toEqual(results[0]);
    }
  });

  it("rejects generated overlapping parallel scopes and accepts disjoint ones", () => {
    const cases = [
      ["packages/mission-engine/**", "packages/mission-engine/src/index.ts"],
      ["apps/*/src/**", "apps/control-plane/src/app.ts"],
      ["docs/**", "docs/adr/*.md"],
      ["**", "packages/protocol/src/index.ts"],
    ] as const;

    for (const [leftScope, rightScope] of cases) {
      const result = validateMissionPlan(
        plan([task("left", { writeScope: [leftScope] }), task("right", { writeScope: [rightScope] })]),
      );
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "parallel_write_scope_overlap",
          taskIds: ["left", "right"],
          writeScopes: [`${leftScope} <> ${rightScope}`],
        }),
      );
    }

    for (let index = 0; index < 25; index += 1) {
      const result = validateMissionPlan(
        plan([
          task(`left-${index}`, { writeScope: [`packages/lane-${index}/**`] }),
          task(`right-${index}`, { writeScope: [`packages/lane-${index + 1_000}/**`] }),
        ]),
      );
      expect(result.valid).toBe(true);
    }
  });

  it("allows an explicit dependency to serialize overlapping write scopes", () => {
    const result = validateMissionPlan(
      plan([
        task("implement", { writeScope: ["packages/mission-engine/**"] }),
        task("integrate", {
          kind: "integration",
          dependsOn: ["implement"],
          writeScope: ["packages/mission-engine/src/index.ts"],
        }),
      ]),
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects self-verification shapes before acceptance", () => {
    const invalidShapes = [
      task("implementer-verifies", { kind: "verification", role: "implementer" }),
      task("verifier-implements", { kind: "implementation", role: "verifier" }),
      task("verifier-writes", {
        kind: "verification",
        role: "verifier",
        writeScope: ["src/**"],
      }),
    ];

    for (const invalidTask of invalidShapes) {
      const candidate = plan([invalidTask]);
      expect(() => assertValidMissionPlan(candidate)).toThrow(MissionPlanValidationError);
      try {
        assertValidMissionPlan(candidate);
      } catch (error) {
        expect(error).toBeInstanceOf(MissionPlanValidationError);
        expect((error as MissionPlanValidationError).evidence).toMatchObject({
          valid: false,
          issues: [expect.objectContaining({ code: "self_verification", taskIds: [invalidTask.id] })],
        });
        expect((error as Error).message).toContain(`"${invalidTask.id}"`);
      }
    }
  });

  it("requires debugging work to use the debugger role", () => {
    const invalid = plan([
      task("repair", { kind: "debugging", role: "implementer", writeScope: ["src/**"] }),
    ]);

    expect(() => assertValidMissionPlan(invalid)).toThrow(MissionPlanValidationError);
    expect(validateMissionPlan(invalid).issues).toContainEqual({
      code: "debugger_role_mismatch",
      message:
        'Debugger task "repair" uses role "implementer"; assign it the debugger role so failure evidence is routed to a repair worker.',
      taskIds: ["repair"],
    });
  });

  it("returns identical evidence on repeated validation", () => {
    const candidate = plan([
      task("a", { writeScope: ["src/**"] }),
      task("b", { writeScope: ["src/file.ts"] }),
    ]);
    const evidence = validateMissionPlan(candidate);

    for (let index = 0; index < 100; index += 1) {
      expect(validateMissionPlan(candidate)).toEqual(evidence);
    }
  });
});
