import { describe, expect, it } from "vitest";
import { renderPiPrompt } from "../src/index.ts";

describe("renderPiPrompt", () => {
  it("protects tests and external authority", () => {
    const prompt = renderPiPrompt({
      missionId: "m",
      workspacePath: "/tmp",
      profileHash: "p",
      attempt: 1,
      signal: new AbortController().signal,
      emit: () => undefined,
      task: {
        id: "t",
        title: "Debug",
        objective: "Fix failure",
        kind: "debugging",
        dependsOn: [],
        executionClass: "runner_visible",
        risk: "low",
        writeScope: ["src/**"],
        successCriteria: ["test passes"],
        maxAttempts: 1,
        metadata: {},
      },
    });
    expect(prompt).toContain("Do not modify tests");
    expect(prompt).toContain("Do not merge");
  });
});
