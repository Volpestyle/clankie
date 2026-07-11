import { describe, expect, it } from "vitest";
import { renderTaskPrompt } from "../src/index.ts";

describe("renderTaskPrompt", () => {
  it("makes scope and non-goals explicit", () => {
    const prompt = renderTaskPrompt({
      missionId: "m1",
      workspacePath: "/tmp/repo",
      profileHash: "p1",
      attempt: 1,
      signal: new AbortController().signal,
      emit: () => undefined,
      task: {
        id: "t1",
        title: "Implement parser",
        objective: "Add parser",
        kind: "implementation",
        role: "implementer",
        dependsOn: [],
        executionClass: "runner_visible",
        risk: "low",
        writeScope: ["src/parser.ts"],
        successCriteria: ["tests pass"],
        evidenceRequirements: ["Attach the diff and test result."],
        maxAttempts: 1,
        metadata: {},
      },
    });
    expect(prompt).toContain("src/parser.ts");
    expect(prompt).toContain("Role: implementer");
    expect(prompt).toContain("Attach the diff and test result.");
    expect(prompt).toContain("Do not merge");
  });
});
