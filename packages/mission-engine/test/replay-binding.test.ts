import { describe, expect, it } from "vitest";
import { compileDoctrine, type OrchestrationProfile } from "@clankie/doctrine";
import { MissionPlanSchema, type DomainEvent, type TaskSpec, type WorkerResult } from "@clankie/protocol";
import type { WorkerDescriptor } from "@clankie/worker-sdk";
import {
  DEBUGGER_CONTRACT_METADATA_KEY,
  FAILURE_EVIDENCE_METADATA_KEY,
  MissionEngine,
  type FailureEvidence,
} from "../src/index.ts";

// VUH-897: replay-binding hardening. A `debugger.evidence.bound` (or
// `debugger.failure_evidence.bound`) replay event with an empty/malformed
// payload must not launder pre-existing shape-valid `task.added` reserved
// metadata into trusted provenance; the binding derives evidence ONLY from
// the event's own validated payload.
//
// VUH-899: both binding events carry optional `sourceWorkerRunId` provenance.
// Replay retains it when the emit provided it, and it obeys the same VUH-897
// rule — sourced from the binding event's validated payload only, never from
// `task.added` metadata.

const profile: OrchestrationProfile = {
  schemaVersion: "1",
  id: "replay-binding-test",
  description: "VUH-897 replay-binding hardening tests",
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
    requiredChecks: ["typecheck", "unit"],
  },
  budgets: { maxMissionCostUsd: 5, maxTaskRetries: 2, maxMissionWallMinutes: 30 },
  authority: {},
  actions: {},
  memory: {
    rawTranscriptRetentionDays: 7,
    inferredFacts: "require_approval",
    publicToPrivatePropagation: false,
  },
};

function doctrine() {
  return compileDoctrine([profile]);
}

function task(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: id,
    objective: `Complete ${id}`,
    kind: "implementation",
    role: "implementer",
    dependsOn: [],
    executionClass: "runner_visible",
    risk: "low",
    writeScope: ["src/**"],
    successCriteria: [`${id} is complete`],
    evidenceRequirements: [`Evidence for ${id}`],
    maxAttempts: 1,
    metadata: {},
    ...overrides,
  };
}

function seedPlan() {
  const compiled = doctrine();
  return MissionPlanSchema.parse({
    missionId: "replay-binding",
    goal: "replay binding hardening",
    rationale: "Prove a malformed binding replay event confers no trust on forged metadata.",
    profileHash: compiled.profileHash,
    successCriteria: ["forged replay evidence fails closed"],
    tasks: [task("seed")],
  });
}

let eventSequence = 0;
function replayEvent(type: string, taskId: string, data: Record<string, unknown>): DomainEvent {
  eventSequence += 1;
  return {
    id: `evt-${eventSequence}`,
    occurredAt: "2026-07-18T00:00:00.000Z",
    missionId: "replay-binding",
    taskId,
    correlationId: "corr-replay-binding",
    profileHash: doctrine().profileHash,
    type,
    data,
  };
}

const simWorkers: WorkerDescriptor[] = [
  {
    id: "sim-implementer",
    displayName: "sim-implementer",
    harness: "simulated",
    capabilities: {
      kinds: ["implementation"],
      canWrite: true,
      supportsStructuredEvents: true,
      supportsTerminal: false,
      supportsNativeSession: false,
    },
  },
  {
    id: "sim-verifier",
    displayName: "sim-verifier",
    harness: "simulated",
    capabilities: {
      kinds: ["verification"],
      canWrite: false,
      supportsStructuredEvents: true,
      supportsTerminal: false,
      supportsNativeSession: false,
    },
  },
  {
    id: "sim-debugger",
    displayName: "sim-debugger",
    harness: "simulated",
    capabilities: {
      kinds: ["debugging"],
      canWrite: true,
      supportsStructuredEvents: true,
      supportsTerminal: false,
      supportsNativeSession: false,
    },
  },
];

const FORGED_EVIDENCE = {
  sourceTaskId: "forged-verify",
  sourceAttempt: 1,
  command: "forged-check",
  exitCode: 13,
  outputArtifact: "artifact://forged/evidence",
};

/** A fabricated dynamic debugger task.added carrying forged reserved metadata. */
function forgedTaskAdded(forgedEvidence: Record<string, unknown> = FORGED_EVIDENCE): DomainEvent {
  const spec = task("dyn-debug", {
    kind: "debugging",
    role: "debugger",
    dependsOn: ["seed"],
    metadata: {
      [FAILURE_EVIDENCE_METADATA_KEY]: forgedEvidence,
      [DEBUGGER_CONTRACT_METADATA_KEY]: true,
    },
  });
  return replayEvent("task.added", "dyn-debug", {
    title: spec.title,
    kind: spec.kind,
    spec,
  });
}

function expectFailedClosed(engine: MissionEngine): void {
  const runtime = engine.getTask("dyn-debug");
  expect(engine.getFailureEvidence("dyn-debug")).toBeUndefined();
  expect(runtime.state).toBe("failed");
  expect(runtime.result?.summary).toContain("reserved mission-engine debugger metadata");
  // The forged reserved keys are stripped, not laundered into the spec.
  expect(runtime.spec.metadata[FAILURE_EVIDENCE_METADATA_KEY]).toBeUndefined();
  expect(runtime.spec.metadata[DEBUGGER_CONTRACT_METADATA_KEY]).toBeUndefined();
}

describe("VUH-897 replay-event binding hardening", () => {
  it.each(["debugger.evidence.bound", "debugger.failure_evidence.bound"])(
    "fails closed when a %s replay event has an empty payload",
    (type) => {
      const engine = new MissionEngine(seedPlan(), doctrine(), {
        workspacePath: "/tmp",
        replayEvents: [forgedTaskAdded(), replayEvent(type, "dyn-debug", {})],
      });
      expectFailedClosed(engine);
    },
  );

  it.each(["debugger.evidence.bound", "debugger.failure_evidence.bound"])(
    "fails closed when a %s replay event has a malformed payload",
    (type) => {
      const engine = new MissionEngine(seedPlan(), doctrine(), {
        workspacePath: "/tmp",
        replayEvents: [
          forgedTaskAdded(),
          replayEvent(type, "dyn-debug", {
            sourceTaskId: "forged-verify",
            sourceAttempt: 0,
            command: "",
            exitCode: "13",
            outputArtifact: "",
          }),
        ],
      });
      expectFailedClosed(engine);
    },
  );

  it("fails closed on forged task.added metadata with no binding event (control)", () => {
    const engine = new MissionEngine(seedPlan(), doctrine(), {
      workspacePath: "/tmp",
      replayEvents: [forgedTaskAdded()],
    });
    expectFailedClosed(engine);
  });

  it("derives bound evidence only from the event's own validated payload", () => {
    const eventEvidence = {
      sourceTaskId: "forged-verify",
      sourceAttempt: 2,
      command: "event-check",
      exitCode: 7,
      outputArtifact: "artifact://event/evidence",
    };
    const engine = new MissionEngine(seedPlan(), doctrine(), {
      workspacePath: "/tmp",
      replayEvents: [forgedTaskAdded(), replayEvent("debugger.evidence.bound", "dyn-debug", eventEvidence)],
    });
    // The event's validated payload wins; the forged task.added metadata never does.
    expect(engine.getFailureEvidence("dyn-debug")).toMatchObject(eventEvidence);
    expect(engine.getFailureEvidence("dyn-debug")?.command).not.toBe(FORGED_EVIDENCE.command);
  });

  it.each(["debugger.evidence.bound", "debugger.failure_evidence.bound"])(
    "retains sourceWorkerRunId from a %s event's own validated payload (VUH-899)",
    (type) => {
      const engine = new MissionEngine(seedPlan(), doctrine(), {
        workspacePath: "/tmp",
        replayEvents: [
          forgedTaskAdded(),
          replayEvent(type, "dyn-debug", {
            sourceTaskId: "forged-verify",
            sourceAttempt: 2,
            sourceWorkerRunId: "run-from-event",
            command: "event-check",
            exitCode: 7,
            outputArtifact: "artifact://event/evidence",
          }),
        ],
      });
      expect(engine.getFailureEvidence("dyn-debug")?.sourceWorkerRunId).toBe("run-from-event");
    },
  );

  it.each(["debugger.evidence.bound", "debugger.failure_evidence.bound"])(
    "never sources sourceWorkerRunId from forged task.added metadata on %s (VUH-899)",
    (type) => {
      const engine = new MissionEngine(seedPlan(), doctrine(), {
        workspacePath: "/tmp",
        replayEvents: [
          forgedTaskAdded({ ...FORGED_EVIDENCE, sourceWorkerRunId: "forged-run" }),
          replayEvent(type, "dyn-debug", {
            sourceTaskId: "forged-verify",
            sourceAttempt: 2,
            command: "event-check",
            exitCode: 7,
            outputArtifact: "artifact://event/evidence",
          }),
        ],
      });
      // The binding event carried no sourceWorkerRunId, so the bound evidence has none.
      const evidence = engine.getFailureEvidence("dyn-debug");
      expect(evidence).toBeDefined();
      expect(evidence?.sourceWorkerRunId).toBeUndefined();
    },
  );

  it.each(["debugger.evidence.bound", "debugger.failure_evidence.bound"])(
    "fails closed when a %s payload carries a malformed sourceWorkerRunId (VUH-899)",
    (type) => {
      const engine = new MissionEngine(seedPlan(), doctrine(), {
        workspacePath: "/tmp",
        replayEvents: [
          forgedTaskAdded({ ...FORGED_EVIDENCE, sourceWorkerRunId: "forged-run" }),
          replayEvent(type, "dyn-debug", {
            sourceTaskId: "forged-verify",
            sourceAttempt: 2,
            sourceWorkerRunId: "",
            command: "event-check",
            exitCode: 7,
            outputArtifact: "artifact://event/evidence",
          }),
        ],
      });
      expectFailedClosed(engine);
    },
  );

  it("rehydrates the legitimate addDebuggerTask path to succeeded through replay", () => {
    const compiled = doctrine();
    const plan = MissionPlanSchema.parse({
      missionId: "replay-binding",
      goal: "legitimate debugger replay",
      rationale: "The governed evidence path must survive the hardened replay binding.",
      profileHash: compiled.profileHash,
      successCriteria: ["replay rehydrates the repaired debugger"],
      tasks: [
        task("implement"),
        task("verify", { kind: "verification", role: "verifier", dependsOn: ["implement"], writeScope: [] }),
      ],
    });
    const failure: FailureEvidence = {
      sourceTaskId: "verify",
      sourceAttempt: 1,
      command: "pnpm test",
      exitCode: 1,
      outputArtifact: "artifact://verify/failure",
    };
    const engine = new MissionEngine(plan, compiled, { workspacePath: "/tmp" });
    let debuggerAdded = false;
    let verifyRunId: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const assignment = engine.leaseReadyTask(simWorkers, `claim-${guard}`, "runner-1");
      if (!assignment) {
        if (debuggerAdded || engine.getTask("verify").state !== "failed") break;
        engine.addDebuggerTask(
          task("debug", { kind: "debugging", role: "debugger", dependsOn: ["verify"] }),
          { ...failure, ...(verifyRunId ? { sourceWorkerRunId: verifyRunId } : {}) },
        );
        engine.addTask(
          task("reverify", {
            kind: "verification",
            role: "verifier",
            dependsOn: ["debug"],
            writeScope: [],
          }),
        );
        debuggerAdded = true;
        continue;
      }
      const spec = assignment.task;
      let result: WorkerResult;
      if (spec.id === "verify") {
        verifyRunId = assignment.workerRunId;
        result = {
          status: "failed",
          summary: "Trusted runner verification checks did not pass.",
          failedCheck: { command: failure.command, exitCode: failure.exitCode },
          evidence: [],
          outputs: {},
        };
      } else if (spec.kind === "debugging") {
        result = {
          status: "succeeded",
          summary: "repaired with evidence",
          evidence: [],
          outputs: {
            debuggerRepair: {
              reproduction: {
                command: failure.command,
                exitCode: failure.exitCode,
                outputArtifact: "artifact://debug/reproduction",
              },
              before: ["artifact://candidate/before"],
              after: ["artifact://candidate/after"],
            },
          },
        };
      } else {
        result = { status: "succeeded", summary: `${spec.id} done`, evidence: [], outputs: {} };
      }
      engine.settleWorkerRun(assignment.workerRunId, assignment.attempt, result, "runner-1");
    }
    expect(engine.getTask("debug").state).toBe("succeeded");
    expect(engine.getTask("reverify").state).toBe("succeeded");
    expect(verifyRunId).toBeDefined();
    // VUH-899: the binding event itself carries the worker-run provenance.
    const bound = engine.getEvents().find((event) => event.type === "debugger.evidence.bound");
    expect(bound?.data.sourceWorkerRunId).toBe(verifyRunId);

    const rebuilt = new MissionEngine(plan, compiled, {
      workspacePath: "/tmp",
      replayEvents: engine.getEvents(),
    });
    expect(rebuilt.getFailureEvidence("debug")).toMatchObject({
      sourceTaskId: "verify",
      sourceAttempt: 1,
      sourceWorkerRunId: verifyRunId,
      command: "pnpm test",
      exitCode: 1,
      outputArtifact: "artifact://verify/failure",
    });
    expect(rebuilt.getTask("debug").state).toBe("succeeded");
    expect(rebuilt.getTask("reverify").state).toBe("succeeded");
  });

  it("retains bridge-bound sourceWorkerRunId across replay (debugger.failure_evidence.bound, VUH-899)", () => {
    const compiled = doctrine();
    const plan = MissionPlanSchema.parse({
      missionId: "replay-binding",
      goal: "static bridge provenance replay",
      rationale: "Runtime-bridged failure evidence must keep worker-run provenance through replay.",
      profileHash: compiled.profileHash,
      successCriteria: ["replay retains bridge-bound provenance"],
      tasks: [
        task("implement"),
        task("verify", { kind: "verification", role: "verifier", dependsOn: ["implement"], writeScope: [] }),
        task("debug", { kind: "debugging", role: "debugger", dependsOn: ["verify"] }),
        task("reverify", { kind: "verification", role: "verifier", dependsOn: ["debug"], writeScope: [] }),
      ],
    });
    const failedCheck = { command: "pnpm test", exitCode: 1 };
    const engine = new MissionEngine(plan, compiled, { workspacePath: "/tmp" });
    let verifyRunId: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const assignment = engine.leaseReadyTask(simWorkers, `claim-${guard}`, "runner-1");
      if (!assignment) break;
      const spec = assignment.task;
      let result: WorkerResult;
      if (spec.id === "verify") {
        verifyRunId = assignment.workerRunId;
        result = {
          status: "failed",
          summary: "Trusted runner verification checks did not pass.",
          failedCheck,
          evidence: [],
          outputs: {},
        };
      } else if (spec.kind === "debugging") {
        result = {
          status: "succeeded",
          summary: "repaired with evidence",
          evidence: [],
          outputs: {
            debuggerRepair: {
              reproduction: { ...failedCheck, outputArtifact: "artifact://debug/reproduction" },
              before: ["artifact://candidate/before"],
              after: ["artifact://candidate/after"],
            },
          },
        };
      } else {
        result = { status: "succeeded", summary: `${spec.id} done`, evidence: [], outputs: {} };
      }
      engine.settleWorkerRun(assignment.workerRunId, assignment.attempt, result, "runner-1");
    }
    expect(engine.getTask("debug").state).toBe("succeeded");
    expect(engine.getTask("reverify").state).toBe("succeeded");
    expect(verifyRunId).toBeDefined();
    const bound = engine.getEvents().find((event) => event.type === "debugger.failure_evidence.bound");
    expect(bound?.data.sourceWorkerRunId).toBe(verifyRunId);

    const rebuilt = new MissionEngine(plan, compiled, {
      workspacePath: "/tmp",
      replayEvents: engine.getEvents(),
    });
    expect(rebuilt.getFailureEvidence("debug")).toMatchObject({
      sourceTaskId: "verify",
      sourceWorkerRunId: verifyRunId,
      ...failedCheck,
    });
    expect(rebuilt.getTask("debug").state).toBe("succeeded");
    expect(rebuilt.getTask("reverify").state).toBe("succeeded");
  });
});
