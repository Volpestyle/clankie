import { describe, expect, it } from "vitest";
import type { ActionRequest } from "@sapling/protocol";
import { compileDoctrine, decideAction, type OrchestrationProfile } from "../src/index.ts";

const base: OrchestrationProfile = {
  schemaVersion: "1",
  id: "test",
  description: "Test doctrine",
  planning: {
    requirePlanApproval: false,
    scopeExpansion: "ask",
    targetReviewMinutes: 20,
    softChangedLines: 300,
    hardChangedLines: 800,
    maxLogicalConcernsPerPr: 1,
  },
  topology: {
    maxParallelWorkers: 3,
    maxDelegationDepth: 2,
    defaultExecution: "runner_visible",
    route: [{ kinds: ["research"], execution: "eve_subagent" }],
  },
  verification: {
    independentVerifier: true,
    differentHarnessPreferred: true,
    requireEvidence: true,
    requiredChecks: ["unit"],
  },
  budgets: { maxMissionCostUsd: 5, maxTaskRetries: 1, maxMissionWallMinutes: 30 },
  authority: {},
  actions: {
    "github.pr.merge": {
      default: "require_approval",
      rules: [
        {
          id: "allow-low-risk-green",
          effect: "allow",
          when: { maxRisk: "low", checksPassed: true, minHumanApprovals: 1, maxChangedLines: 300 },
          obligations: ["use_merge_queue"],
          reason: "Low-risk, reviewed, green PR.",
        },
      ],
    },
  },
  memory: {
    rawTranscriptRetentionDays: 7,
    inferredFacts: "require_approval",
    publicToPrivatePropagation: false,
  },
};

function request(risk: "low" | "high", approvals: number): ActionRequest {
  return {
    id: "a1",
    principal: { kind: "captain", id: "captain" },
    action: "github.pr.merge",
    resource: { type: "pull_request", id: "184", repository: "acme/app" },
    context: {
      missionId: "m1",
      risk,
      checksPassed: true,
      humanApprovals: approvals,
      changedLines: 120,
      profileHash: "hash",
    },
  };
}

describe("doctrine", () => {
  it("routes task kinds deterministically", () => {
    const compiled = compileDoctrine([base]);
    expect(compiled.routing.research).toBe("eve_subagent");
    expect(compiled.routing.implementation).toBe("runner_visible");
  });

  it("allows only when a specific rule matches", () => {
    const compiled = compileDoctrine([base]);
    expect(decideAction(compiled, request("low", 1)).effect).toBe("allow");
    expect(decideAction(compiled, request("high", 1)).effect).toBe("require_approval");
    expect(decideAction(compiled, request("low", 0)).effect).toBe("require_approval");
  });

  it("denies unknown capabilities", () => {
    const compiled = compileDoctrine([base]);
    const unknown = { ...request("low", 1), action: "deployment.production.create" };
    expect(decideAction(compiled, unknown).effect).toBe("deny");
  });

  it("does not let lower scopes loosen a higher-scope deny", () => {
    const org = {
      ...base,
      actions: {
        ...base.actions,
        "deployment.production.create": { default: "deny" as const, rules: [] },
      },
    };
    const mission = {
      ...base,
      id: "mission",
      actions: {
        ...base.actions,
        "deployment.production.create": { default: "allow" as const, rules: [] },
      },
    };
    const compiled = compileDoctrine([org, mission]);
    expect(compiled.profile.actions["deployment.production.create"]?.default).toBe("deny");
  });
});
