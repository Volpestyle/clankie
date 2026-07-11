import { describe, expect, it } from "vitest";
import { compileDoctrine, type OrchestrationProfile } from "@sapling/doctrine";
import { MissionPlanSchema, type WorkerResult } from "@sapling/protocol";
import { StaticWorkerRouter, type WorkerAdapter } from "@sapling/worker-sdk";
import { MissionEngine } from "../src/index.ts";

const profile: OrchestrationProfile = {
  schemaVersion: "1",
  id: "engine-test",
  description: "Engine test",
  planning: {
    requirePlanApproval: false,
    scopeExpansion: "ask",
    targetReviewMinutes: 20,
    softChangedLines: 300,
    hardChangedLines: 800,
    maxLogicalConcernsPerPr: 1,
  },
  topology: {
    maxParallelWorkers: 2,
    maxDelegationDepth: 2,
    defaultExecution: "runner_visible",
    route: [],
  },
  verification: {
    independentVerifier: true,
    differentHarnessPreferred: true,
    requireEvidence: true,
    requiredChecks: ["unit"],
  },
  budgets: { maxMissionCostUsd: 5, maxTaskRetries: 1, maxMissionWallMinutes: 30 },
  authority: {},
  actions: {},
  memory: {
    rawTranscriptRetentionDays: 7,
    inferredFacts: "require_approval",
    publicToPrivatePropagation: false,
  },
};

function worker(id: string, kinds: Array<"implementation" | "verification">): WorkerAdapter {
  return {
    descriptor: {
      id,
      displayName: id,
      harness: "simulated",
      capabilities: {
        kinds,
        canWrite: kinds.includes("implementation"),
        supportsStructuredEvents: true,
        supportsTerminal: false,
        supportsNativeSession: false,
      },
    },
    async run(): Promise<WorkerResult> {
      return { status: "succeeded", summary: "done", evidence: [], outputs: {} };
    },
  };
}

describe("MissionEngine", () => {
  it("uses an independent worker for verification", async () => {
    const doctrine = compileDoctrine([profile]);
    const plan = MissionPlanSchema.parse({
      missionId: "m1",
      goal: "test",
      rationale: "test",
      profileHash: doctrine.profileHash,
      successCriteria: ["done"],
      tasks: [
        {
          id: "implement",
          title: "Implement",
          objective: "Implement",
          kind: "implementation",
          successCriteria: ["done"],
        },
        {
          id: "verify",
          title: "Verify",
          objective: "Verify",
          kind: "verification",
          dependsOn: ["implement"],
          successCriteria: ["passes"],
        },
      ],
    });
    const engine = new MissionEngine(plan, doctrine, { workspacePath: "/tmp" });
    const router = new StaticWorkerRouter([
      worker("builder", ["implementation", "verification"]),
      worker("reviewer", ["verification"]),
    ]);
    await engine.runUntilIdle(router);
    expect(engine.getTask("implement").workerId).toBe("builder");
    expect(engine.getTask("verify").workerId).toBe("reviewer");
  });
});
