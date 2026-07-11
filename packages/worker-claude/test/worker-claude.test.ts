import { describe, expect, it } from "vitest";
import { renderClaudePrompt } from "../src/index.ts";

describe("renderClaudePrompt", () => {
  it("defines the lead-worker boundary", () => {
    const prompt = renderClaudePrompt({
      missionId: "m",
      workspacePath: "/tmp",
      profileHash: "p",
      attempt: 1,
      signal: new AbortController().signal,
      emit: () => undefined,
      task: {
        id: "review",
        title: "Review change",
        objective: "Find defects",
        kind: "review",
        role: "reviewer",
        dependsOn: [],
        executionClass: "runner_headless",
        risk: "medium",
        writeScope: [],
        successCriteria: ["find regressions"],
        evidenceRequirements: ["Report findings with file locations."],
        maxAttempts: 1,
        metadata: {},
      },
    });
    expect(prompt).toContain("lead owns intent");
    expect(prompt).toContain("Role: reviewer");
    expect(prompt).toContain("Report findings with file locations.");
    expect(prompt).toContain("read-only");
  });
});
