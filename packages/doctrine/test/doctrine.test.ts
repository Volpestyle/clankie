import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MissionPlanSchema, type ActionRequest, type TaskKind } from "@sapling/protocol";
import { MissionEngine } from "../../mission-engine/src/index.ts";
import { StaticWorkerRouter, type WorkerAdapter } from "../../worker-sdk/src/index.ts";
import {
  compileDoctrine,
  createConnectorActionClassifier,
  decideAction,
  decideCapabilityRequest,
  loadDoctrineFile,
  loadDoctrineLayerFile,
  permitsCapabilityGrant,
  resolveAuthorityBinding,
  type OrchestrationProfile,
} from "../src/index.ts";

const profileDirectory = resolve(import.meta.dirname, "../../../doctrine/profiles");
const classifyTestAction = createConnectorActionClassifier([
  { action: "unreal.scene.read", riskClass: "read" },
  { action: "unreal.scene.delete", riskClass: "destructive" },
]);

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

function successfulWorker(id: string, kind: TaskKind): WorkerAdapter {
  return {
    descriptor: {
      id,
      displayName: id,
      harness: "simulated",
      capabilities: {
        kinds: [kind],
        canWrite: kind === "implementation",
        supportsStructuredEvents: true,
        supportsTerminal: false,
        supportsNativeSession: false,
      },
    },
    run: (context) =>
      Promise.resolve({
        status: "succeeded",
        summary: `${context.task.id} completed`,
        evidence: [
          {
            kind: "test_report",
            label: `${context.task.id}-evidence`,
            summary: `${context.task.id} passed`,
          },
        ],
        outputs: { workerRunId: context.workerRunId },
      }),
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

  it("mints worker capabilities only for an explicit allow decision", () => {
    const compiled = compileDoctrine([base]);
    const merge = { ...request("low", 1), principal: { kind: "worker" as const, id: "run-1" } };
    const allowed = decideCapabilityRequest(compiled, merge);
    expect(allowed.effect).toBe("allow");
    expect(permitsCapabilityGrant(allowed)).toBe(true);

    const approvalRequired = decideCapabilityRequest(compiled, {
      ...merge,
      context: { ...merge.context, humanApprovals: 0 },
    });
    expect(approvalRequired.effect).toBe("require_approval");
    expect(permitsCapabilityGrant(approvalRequired)).toBe(false);

    for (const action of ["deployment.production.create", "package.release.publish"]) {
      const denied = decideCapabilityRequest(compiled, { ...merge, action });
      expect(denied.effect).toBe("deny");
      expect(permitsCapabilityGrant(denied)).toBe(false);
    }
  });

  it("refuses to issue a worker capability for another principal kind", () => {
    const compiled = compileDoctrine([base]);
    const decision = decideCapabilityRequest(compiled, request("low", 1));
    expect(decision).toMatchObject({
      effect: "deny",
      matchedPolicyIds: ["capability-worker-only"],
    });
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

  it("ships exactly three user presets and keeps eval and assurance layers separate", async () => {
    const files = (await readdir(profileDirectory)).filter((file) => file.endsWith(".yaml"));
    const profiles = await Promise.all(
      files.map((file) => loadDoctrineLayerFile(resolve(profileDirectory, file))),
    );

    expect(
      profiles
        .filter((profile) => profile.kind === "preset")
        .map((profile) => profile.id)
        .sort(),
    ).toEqual(["fine-control", "rawdog", "structured"]);
    expect(profiles.find((profile) => profile.id === "self-build-lab")?.kind).toBe("internal");
    expect(profiles.find((profile) => profile.id === "high-assurance-overlay")?.kind).toBe("overlay");
  });

  it("uses risk-class posture for a previously unknown connector action", async () => {
    const rawdog = compileDoctrine([await loadDoctrineFile(resolve(profileDirectory, "rawdog.yaml"))]);
    const unknown: ActionRequest = {
      ...request("high", 0),
      principal: { kind: "worker", id: "run-unreal" },
      action: "unreal.scene.delete",
      resource: { type: "scene", id: "level-1" },
    };

    expect(decideCapabilityRequest(rawdog, unknown, classifyTestAction(unknown.action))).toMatchObject({
      effect: "require_approval",
      matchedPolicyIds: ["risk-class:destructive:default"],
    });
  });

  it("resolves every rawdog authority role without an external connector", async () => {
    const rawdog = compileDoctrine([await loadDoctrineFile(resolve(profileDirectory, "rawdog.yaml"))]);

    for (const role of Object.keys(rawdog.profile.authority)) {
      expect(resolveAuthorityBinding(rawdog, role).kind).not.toBe("connector");
    }
    expect(rawdog.profile.ceremony?.externalConnectors).toBe("none");
  });

  it("runs a rawdog mission end to end with zero external connectors", async () => {
    const rawdog = compileDoctrine([await loadDoctrineFile(resolve(profileDirectory, "rawdog.yaml"))]);
    const plan = MissionPlanSchema.parse({
      missionId: "rawdog-zero-connectors",
      goal: "Complete and independently verify local work",
      rationale: "Rawdog binds authority to the operator and local state.",
      profileHash: rawdog.profileHash,
      successCriteria: ["Implementation and verification tasks succeed."],
      tasks: [
        {
          id: "implement",
          title: "Implement locally",
          objective: "Complete a local implementation task.",
          kind: "implementation",
          role: "implementer",
          successCriteria: ["The implementation succeeds."],
          evidenceRequirements: ["Implementation evidence is attached."],
        },
        {
          id: "verify",
          title: "Verify independently",
          objective: "Verify the local implementation.",
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          successCriteria: ["The verification succeeds."],
          evidenceRequirements: ["Verification evidence is attached."],
        },
      ],
    });
    const engine = new MissionEngine(plan, rawdog, { workspacePath: "/tmp/rawdog-mission" });
    await engine.runUntilIdle(
      new StaticWorkerRouter([
        successfulWorker("builder", "implementation"),
        successfulWorker("verifier", "verification"),
      ]),
    );

    expect(engine.getSnapshot().state).toBe("verifying");
    expect(engine.getSnapshot().tasks.every((task) => task.state === "succeeded")).toBe(true);
    expect(Object.values(rawdog.profile.authority).every((binding) => binding.kind !== "connector")).toBe(
      true,
    );
    engine.completeMission("Independent verification passed using local authority bindings.");
    expect(engine.getSnapshot().state).toBe("succeeded");
  });

  it("holds approval and test-integrity invariants under every user preset", async () => {
    for (const id of ["rawdog", "structured", "fine-control"]) {
      const doctrine = compileDoctrine([await loadDoctrineFile(resolve(profileDirectory, `${id}.yaml`))]);
      for (const action of ["deployment.production.create", "shell.destructive"]) {
        expect(decideAction(doctrine, { ...request("low", 0), action }).effect).toBe("require_approval");
      }
      expect(decideAction(doctrine, { ...request("low", 0), action: "test.integrity.weaken" }).effect).toBe(
        "deny",
      );
      expect(doctrine.profile.verification.independentVerifier).toBe(true);
    }
  });

  it("layers high assurance over a preset and hashes the effective risk posture", async () => {
    const structured = await loadDoctrineFile(resolve(profileDirectory, "structured.yaml"));
    const overlay = await loadDoctrineLayerFile(resolve(profileDirectory, "high-assurance-overlay.yaml"));
    const baseline = compileDoctrine([structured]);
    const hardened = compileDoctrine([structured, overlay]);

    expect(hardened.profile.id).toBe("structured");
    expect(hardened.profile.kind).toBe("preset");
    expect(hardened.profile.ceremony).toEqual(structured.ceremony);
    expect(hardened.profile.authority).toEqual(structured.authority);
    expect(hardened.profile.planning.hardChangedLines).toBe(350);
    expect(hardened.profile.riskClasses?.["reversible-write"].default).toBe("require_approval");
    expect(hardened.profileHash).not.toBe(baseline.profileHash);
  });

  it("does not let the assurance overlay add ceremony or connectors to rawdog", async () => {
    const rawdog = await loadDoctrineFile(resolve(profileDirectory, "rawdog.yaml"));
    const overlay = await loadDoctrineLayerFile(resolve(profileDirectory, "high-assurance-overlay.yaml"));
    const hardened = compileDoctrine([rawdog, overlay]);

    expect(hardened.profile.id).toBe("rawdog");
    expect(hardened.profile.ceremony).toEqual({
      externalConnectors: "none",
      integrationFlow: "direct_main",
    });
    expect(Object.values(hardened.profile.authority).every((binding) => binding.kind !== "connector")).toBe(
      true,
    );
  });

  it("does not let an action override drop the destructive invariant floor", () => {
    const doctrine = compileDoctrine([
      {
        ...base,
        actions: {
          "unreal.scene.delete": { default: "allow", rules: [] },
        },
      },
    ]);
    const decision = decideAction(
      doctrine,
      {
        ...request("low", 0),
        action: "unreal.scene.delete",
      },
      classifyTestAction("unreal.scene.delete"),
    );

    expect(decision.effect).toBe("require_approval");
    expect(decision.matchedPolicyIds).toContain("invariant-floor:human-approval");
  });

  it("rejects forged risk classification that did not come from connector metadata", async () => {
    const rawdog = compileDoctrine([await loadDoctrineFile(resolve(profileDirectory, "rawdog.yaml"))]);
    const decision = decideAction(rawdog, { ...request("low", 0), action: "unreal.scene.delete" }, {
      riskClass: "read",
    } as never);

    expect(decision).toMatchObject({
      effect: "deny",
      matchedPolicyIds: ["untrusted-action-classification"],
    });

    expect(
      decideAction(
        rawdog,
        { ...request("low", 0), action: "unreal.scene.delete" },
        classifyTestAction("unreal.scene.read"),
      ),
    ).toMatchObject({
      effect: "deny",
      matchedPolicyIds: ["untrusted-action-classification"],
    });
  });

  it("does not let an action override weaken test integrity", () => {
    const doctrine = compileDoctrine([
      {
        ...base,
        actions: {
          "test.integrity.weaken": { default: "allow", rules: [] },
        },
      },
    ]);

    expect(decideAction(doctrine, { ...request("low", 0), action: "test.integrity.weaken" })).toMatchObject({
      effect: "deny",
      matchedPolicyIds: ["test.integrity.weaken:default", "invariant-floor:test-integrity"],
    });
  });

  it("rejects any doctrine layer that disables independent verification", () => {
    expect(() =>
      compileDoctrine([
        {
          ...base,
          verification: { ...base.verification, independentVerifier: false },
        },
      ]),
    ).toThrow("invariant floor requires an independent verifier");
  });
});
