import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MissionPlanSchema, type ActionRequest, type TaskKind } from "@clankie/protocol";
import { MissionEngine } from "../../mission-engine/src/index.ts";
import { StaticWorkerRouter, type WorkerAdapter } from "../../worker-sdk/src/index.ts";
import {
  compileDoctrine,
  createConnectorActionClassifier,
  createNarrativeWritePolicy,
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
const narrativeActions = [
  ["tracker.comment.create", "issue-comment"],
  ["tracker.agent-activity.thought.create", "agent-activity-thought"],
  ["tracker.agent-activity.response.create", "agent-activity-response"],
  ["tracker.agent-activity.elicitation.create", "agent-activity-elicitation"],
  ["tracker.reaction.create", "emoji-reaction"],
] as const;
const classifyTrackerAction = createConnectorActionClassifier([
  ...narrativeActions.map(([action, narrativeKind]) => ({
    action,
    riskClass: "narrative-write" as const,
    narrativeKind,
  })),
  { action: "tracker.assignment.mirror", riskClass: "reversible-write" },
  { action: "tracker.status.update", riskClass: "reversible-write" },
  { action: "tracker.priority.update", riskClass: "reversible-write" },
  { action: "tracker.acceptance-criteria.update", riskClass: "reversible-write" },
  { action: "tracker.completion.update", riskClass: "irreversible-write" },
  { action: "tracker.future-mutation.create", riskClass: "reversible-write" },
  { action: "tracker.issue.read", riskClass: "read" },
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

function trackerRequest(
  doctrine: ReturnType<typeof compileDoctrine>,
  action: string,
  missionId = "mission-narrative",
): ActionRequest {
  return {
    ...request("low", 0),
    principal: { kind: "worker", id: "clankie-app" },
    action,
    resource: { type: "tracker_issue", id: "VUH-802" },
    context: {
      ...request("low", 0).context,
      missionId,
      profileHash: doctrine.profileHash,
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

  it("compiles a guarded, default-allow narrative class in every user preset", async () => {
    for (const id of ["rawdog", "structured", "fine-control"]) {
      const doctrine = compileDoctrine([await loadDoctrineFile(resolve(profileDirectory, `${id}.yaml`))]);
      expect(doctrine.profile.riskClasses?.["narrative-write"]).toMatchObject({
        default: "allow",
        obligations: [
          "record_mission_attribution",
          "record_correlation_attribution",
          "enforce_narrative_rate_volume_guardrail",
        ],
        guardrail: {
          windowSeconds: 60,
          maxWritesPerWindow: 20,
          maxBytesPerWrite: 16_384,
          maxBytesPerWindow: 65_536,
        },
      });
    }
  });

  it("allows only whitelisted narrative tracker writes with bound attribution obligations", async () => {
    for (const id of ["rawdog", "structured", "fine-control"]) {
      const doctrine = compileDoctrine([await loadDoctrineFile(resolve(profileDirectory, `${id}.yaml`))]);
      const narrativePolicy = createNarrativeWritePolicy(doctrine, { now: () => 0 });

      for (const [action] of narrativeActions) {
        const actionRequest = trackerRequest(doctrine, action);
        const classification = classifyTrackerAction(action);
        expect(classification).toBeDefined();
        const decision = narrativePolicy.decide({
          request: actionRequest,
          classification: classification!,
          correlationId: `correlation:${action}`,
          content: action === "tracker.reaction.create" ? "eyes" : `Narrative content for ${action}`,
        });

        expect(decision.effect).toBe("allow");
        expect(decision.matchedPolicyIds).toEqual([
          "risk-class:narrative-write:default",
          "narrative-write:guardrail",
        ]);
        expect(decision.obligations).toEqual(
          expect.arrayContaining([
            "record_mission_attribution:mission-narrative",
            `record_correlation_attribution:correlation:${action}`,
            "enforce_narrative_guardrail:20/60s:65536b",
          ]),
        );
      }
    }
  });

  it("keeps tracker authority mutations gated and unknown mutations fail closed for the same identity", async () => {
    for (const id of ["rawdog", "structured", "fine-control"]) {
      const doctrine = compileDoctrine([await loadDoctrineFile(resolve(profileDirectory, `${id}.yaml`))]);
      for (const action of [
        "tracker.status.update",
        "tracker.priority.update",
        "tracker.acceptance-criteria.update",
        "tracker.completion.update",
      ]) {
        const actionRequest = trackerRequest(doctrine, action);
        expect(actionRequest.principal).toEqual({ kind: "worker", id: "clankie-app" });
        expect(decideAction(doctrine, actionRequest, classifyTrackerAction(action))).toMatchObject({
          effect: "require_approval",
          matchedPolicyIds: [`${action}:default`],
        });
      }

      const unknown = trackerRequest(doctrine, "tracker.future-mutation.create");
      expect(decideAction(doctrine, unknown, classifyTrackerAction(unknown.action))).toMatchObject({
        effect: "deny",
        matchedPolicyIds: ["tracker-mutation:implicit-deny"],
      });
      expect(decideAction(doctrine, { ...unknown, action: "tracker.unclassified.create" })).toMatchObject({
        effect: "deny",
        matchedPolicyIds: ["tracker-mutation:implicit-deny"],
      });
      const read = trackerRequest(doctrine, "tracker.issue.read");
      expect(decideAction(doctrine, read, classifyTrackerAction(read.action)).effect).toBe("allow");
    }
  });

  it("does not let an action override weaken tracker authority", async () => {
    const rawdog = await loadDoctrineFile(resolve(profileDirectory, "rawdog.yaml"));
    const doctrine = compileDoctrine([
      {
        ...rawdog,
        actions: {
          ...rawdog.actions,
          "tracker.priority.update": { default: "allow", rules: [] },
        },
      },
    ]);
    const action = "tracker.priority.update";

    expect(
      decideAction(doctrine, trackerRequest(doctrine, action), classifyTrackerAction(action)),
    ).toMatchObject({
      effect: "require_approval",
      matchedPolicyIds: [action + ":default", "invariant-floor:human-approval"],
    });
  });

  it("denies narrative classifications that bypass the trusted guardrail", async () => {
    const rawdog = await loadDoctrineFile(resolve(profileDirectory, "rawdog.yaml"));
    const doctrine = compileDoctrine([rawdog]);
    const action = "tracker.comment.create";
    expect(
      decideAction(doctrine, trackerRequest(doctrine, action), classifyTrackerAction(action)),
    ).toMatchObject({
      effect: "deny",
      matchedPolicyIds: ["narrative-write:guardrail-required"],
    });
    const exactAllow = compileDoctrine([
      {
        ...rawdog,
        actions: { ...rawdog.actions, [action]: { default: "allow", rules: [] } },
      },
    ]);
    expect(
      decideAction(exactAllow, trackerRequest(exactAllow, action), classifyTrackerAction(action)),
    ).toMatchObject({
      effect: "deny",
      matchedPolicyIds: ["narrative-write:guardrail-required"],
    });
    const narrativePolicy = createNarrativeWritePolicy(doctrine, { now: () => 0 });
    expect(
      narrativePolicy.decide({
        request: trackerRequest(doctrine, action),
        classification: classifyTrackerAction(action)!,
        correlationId: "",
        content: "missing correlation",
      }),
    ).toMatchObject({
      effect: "deny",
      matchedPolicyIds: ["narrative-write:attribution"],
    });
    expect(
      narrativePolicy.decide({
        request: {
          ...trackerRequest(doctrine, action),
          context: { ...trackerRequest(doctrine, action).context, profileHash: "stale-profile" },
        },
        classification: classifyTrackerAction(action)!,
        correlationId: "correlation-stale",
        content: "stale profile",
      }),
    ).toMatchObject({
      effect: "deny",
      matchedPolicyIds: ["narrative-write:profile-binding"],
    });
    expect(() =>
      createConnectorActionClassifier([
        { action: "tracker.unknown.create", riskClass: "narrative-write" } as never,
      ]),
    ).toThrow();
  });

  it("enforces narrative rate and volume limits in trusted policy state", async () => {
    const doctrine = compileDoctrine([await loadDoctrineFile(resolve(profileDirectory, "rawdog.yaml"))]);
    let now = 0;
    const narrativePolicy = createNarrativeWritePolicy(doctrine, { now: () => now });
    const action = "tracker.comment.create";
    const classification = classifyTrackerAction(action)!;

    for (let index = 0; index < 20; index += 1) {
      expect(
        narrativePolicy.decide({
          request: trackerRequest(doctrine, action, "mission-rate"),
          classification,
          correlationId: `correlation-${index}`,
          content: "ok",
        }).effect,
      ).toBe("allow");
    }
    expect(
      narrativePolicy.decide({
        request: trackerRequest(doctrine, action, "mission-rate"),
        classification,
        correlationId: "correlation-rotated",
        content: "still a loop",
      }),
    ).toMatchObject({
      effect: "deny",
      matchedPolicyIds: expect.arrayContaining(["narrative-write:guardrail:max-writes-per-window"]),
    });

    now = 60_000;
    expect(
      narrativePolicy.decide({
        request: trackerRequest(doctrine, action, "mission-rate"),
        classification,
        correlationId: "correlation-after-window",
        content: "window reset",
      }).effect,
    ).toBe("allow");

    expect(
      narrativePolicy.decide({
        request: trackerRequest(doctrine, action, "mission-single-volume"),
        classification,
        correlationId: "correlation-single-volume",
        content: "x".repeat(16_385),
      }),
    ).toMatchObject({
      effect: "deny",
      matchedPolicyIds: expect.arrayContaining(["narrative-write:guardrail:max-bytes-per-write"]),
    });

    for (let index = 0; index < 4; index += 1) {
      expect(
        narrativePolicy.decide({
          request: trackerRequest(doctrine, action, "mission-window-volume"),
          classification,
          correlationId: `correlation-volume-${index}`,
          content: "x".repeat(16_384),
        }).effect,
      ).toBe("allow");
    }
    expect(
      narrativePolicy.decide({
        request: trackerRequest(doctrine, action, "mission-window-volume"),
        classification,
        correlationId: "correlation-volume-overflow",
        content: "x",
      }),
    ).toMatchObject({
      effect: "deny",
      matchedPolicyIds: expect.arrayContaining(["narrative-write:guardrail:max-bytes-per-window"]),
    });
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
