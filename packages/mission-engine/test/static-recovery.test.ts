import { describe, expect, it } from "vitest";
import { compileDoctrine, type OrchestrationProfile } from "@clankie/doctrine";
import { MissionPlanSchema, type TaskSpec, type WorkerResult } from "@clankie/protocol";
import { StaticWorkerRouter, type WorkerAdapter } from "@clankie/worker-sdk";
import { MissionEngine } from "../src/index.ts";

// VUH-827: a faithful static VUH-814-shape frozen graph — no pre-bound
// addDebuggerTask metadata — must recover autonomously: the runtime bridge binds
// failure evidence from the failed verification's result so the debugger readies,
// and supersession reports recovery, not terminal failure.

const profile: OrchestrationProfile = {
  schemaVersion: "1",
  id: "static-recovery-test",
  description: "Static frozen-graph recovery tests",
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

/** The faithful VUH-814 frozen shape, with NO pre-bound failure-evidence metadata. */
function frozenPlan() {
  const compiled = doctrine();
  return MissionPlanSchema.parse({
    missionId: "frozen-static",
    goal: "frozen scenario static recovery",
    rationale: "The static plan must recover through the runtime failure-evidence bridge.",
    profileHash: compiled.profileHash,
    successCriteria: ["The five-task frozen graph recovers via debug + re-verify."],
    tasks: [
      task("inspect-context", { kind: "context", role: "planner", writeScope: [] }),
      task("implement-retry", {
        kind: "implementation",
        role: "implementer",
        dependsOn: ["inspect-context"],
      }),
      task("verify-initial", {
        kind: "verification",
        role: "verifier",
        dependsOn: ["implement-retry"],
        writeScope: [],
      }),
      task("debug-retry", { kind: "debugging", role: "debugger", dependsOn: ["verify-initial"] }),
      task("verify-repair", {
        kind: "verification",
        role: "verifier",
        dependsOn: ["debug-retry"],
        writeScope: [],
      }),
    ],
  });
}

function adapter(
  id: string,
  kinds: Array<TaskSpec["kind"]>,
  canWrite: boolean,
  run: WorkerAdapter["run"],
): WorkerAdapter {
  return {
    descriptor: {
      id,
      displayName: id,
      harness: "simulated",
      capabilities: {
        kinds,
        canWrite,
        supportsStructuredEvents: true,
        supportsTerminal: false,
        supportsNativeSession: false,
      },
    },
    run,
  };
}

const succeed = (id: string): WorkerResult => ({
  status: "succeeded",
  summary: `${id} done`,
  evidence: [],
  outputs: {},
});

/** A verifier that fails the initial verification with a reproducible runner check. */
function checkingVerifier(options: { failInitial: boolean; failRepair?: boolean }): WorkerAdapter {
  return adapter("sim-verifier", ["verification"], false, async (context) => {
    const isInitial = context.task.id === "verify-initial";
    const shouldFail = isInitial ? options.failInitial : (options.failRepair ?? false);
    if (!shouldFail) return succeed(context.task.id);
    return {
      status: "failed",
      summary: "Trusted runner verification checks did not pass.",
      diagnosis: "retry-defect-check exited 7",
      evidence: [
        {
          kind: "diff",
          label: "runner-observed-git-diff",
          uri: `artifact://runner-diff/frozen-static/${context.task.id}-1`,
          summary: "1 changed path",
        },
      ],
      outputs: {},
    };
  });
}

const planner = () => adapter("sim-planner", ["context"], false, async (c) => succeed(c.task.id));
const implementer = () =>
  adapter("sim-implementer", ["implementation"], true, async (c) => succeed(c.task.id));
const debuggerWorker = () => adapter("sim-debugger", ["debugging"], true, async (c) => succeed(c.task.id));

describe("VUH-827 static frozen-graph recovery", () => {
  it("completes the Run-A stall shape autonomously with no pre-bound metadata", async () => {
    const engine = new MissionEngine(frozenPlan(), doctrine(), { workspacePath: "/tmp" });
    const router = new StaticWorkerRouter([
      planner(),
      implementer(),
      checkingVerifier({ failInitial: true }),
      debuggerWorker(),
    ]);
    await engine.runUntilIdle(router);

    expect(engine.getTask("inspect-context").state).toBe("succeeded");
    expect(engine.getTask("implement-retry").state).toBe("succeeded");
    expect(engine.getTask("verify-initial").state).toBe("failed");
    expect(engine.getTask("debug-retry").state).toBe("succeeded");
    expect(engine.getTask("verify-repair").state).toBe("succeeded");

    // Recovery, not terminal failure.
    expect(engine.getSnapshot().state).toBe("verifying");

    // Independent verifier ran both verifications (never the writer workers).
    expect(engine.getTask("verify-initial").workerId).toBe("sim-verifier");
    expect(engine.getTask("verify-repair").workerId).toBe("sim-verifier");

    // The bridge bound strict failure evidence at runtime.
    const bound = engine.getEvents().find((event) => event.type === "debugger.failure_evidence.bound");
    expect(bound?.taskId).toBe("debug-retry");
    expect(bound?.data).toMatchObject({
      sourceTaskId: "verify-initial",
      command: "retry-defect-check",
      exitCode: 7,
      boundAtRuntime: true,
    });
    expect(engine.getFailureEvidence("debug-retry")).toMatchObject({
      sourceTaskId: "verify-initial",
      sourceAttempt: 1,
      command: "retry-defect-check",
      exitCode: 7,
      outputArtifact: "artifact://runner-diff/frozen-static/verify-initial-1",
    });
    // No starve event when evidence binds successfully.
    expect(engine.getEvents().some((e) => e.type === "task.debugger_evidence_starved")).toBe(false);
  });

  it("keeps the mission failed when a failed verification has no dependent debugger", async () => {
    const compiled = doctrine();
    const twoTask = MissionPlanSchema.parse({
      missionId: "plain-fail",
      goal: "plain failed verification",
      rationale: "A plain failed verification with no repair chain still fails the mission.",
      profileHash: compiled.profileHash,
      successCriteria: ["verification passes"],
      tasks: [
        task("implement", { kind: "implementation", role: "implementer" }),
        task("verify", { kind: "verification", role: "verifier", dependsOn: ["implement"], writeScope: [] }),
      ],
    });
    const engine = new MissionEngine(twoTask, compiled, { workspacePath: "/tmp" });
    const failingVerifier = adapter("sim-verifier", ["verification"], false, async () => ({
      status: "failed",
      summary: "Trusted runner verification checks did not pass.",
      diagnosis: "unit exited 1",
      evidence: [
        { kind: "diff", label: "runner-observed-git-diff", uri: "artifact://d/verify-1", summary: "x" },
      ],
      outputs: {},
    }));
    await engine.runUntilIdle(new StaticWorkerRouter([implementer(), failingVerifier]));
    expect(engine.getTask("verify").state).toBe("failed");
    expect(engine.getSnapshot().state).toBe("failed");
  });

  it("stays failed when the debugger repairs but re-verification fails", async () => {
    const engine = new MissionEngine(frozenPlan(), doctrine(), { workspacePath: "/tmp" });
    const router = new StaticWorkerRouter([
      planner(),
      implementer(),
      checkingVerifier({ failInitial: true, failRepair: true }),
      debuggerWorker(),
    ]);
    await engine.runUntilIdle(router);
    expect(engine.getTask("debug-retry").state).toBe("succeeded");
    expect(engine.getTask("verify-repair").state).toBe("failed");
    // verify-initial is not superseded (re-verification failed) -> mission fails.
    expect(engine.getSnapshot().state).toBe("failed");
  });

  it("emits a dependency-starve event when the failure has no reproducible check", async () => {
    const engine = new MissionEngine(frozenPlan(), doctrine(), { workspacePath: "/tmp" });
    // Verifier fails without an "exited <n>" signal -> no evidence can be synthesized.
    const unreproducibleVerifier = adapter("sim-verifier", ["verification"], false, async (context) =>
      context.task.id === "verify-initial"
        ? {
            status: "failed",
            summary: "acceptance check failed",
            diagnosis: "the reviewer rejected the change",
            evidence: [],
            outputs: {},
          }
        : succeed(context.task.id),
    );
    const router = new StaticWorkerRouter([
      planner(),
      implementer(),
      unreproducibleVerifier,
      debuggerWorker(),
    ]);
    await engine.runUntilIdle(router);
    expect(engine.getTask("verify-initial").state).toBe("failed");
    // Debugger cannot ready -> stays queued, mission failed, starve event emitted.
    expect(engine.getTask("debug-retry").state).toBe("queued");
    expect(engine.getSnapshot().state).toBe("failed");
    const starve = engine.getEvents().find((e) => e.type === "task.debugger_evidence_starved");
    expect(starve?.taskId).toBe("debug-retry");
    expect(starve?.data).toMatchObject({ sourceTaskId: "verify-initial" });
  });

  it("recovers and rehydrates through the real pull path (leaseReadyTask + settleWorkerRun)", () => {
    // Mirrors the control-plane runner pull loop — the path the real service uses
    // and the one applyReplayEvent fully restores.
    const first = new MissionEngine(frozenPlan(), doctrine(), { workspacePath: "/tmp" });
    drivePullPath(first);
    expect(first.getTask("debug-retry").state).toBe("succeeded");
    expect(first.getTask("verify-repair").state).toBe("succeeded");
    expect(first.getSnapshot().state).toBe("verifying");

    const rebuilt = new MissionEngine(frozenPlan(), doctrine(), {
      workspacePath: "/tmp",
      replayEvents: first.getEvents(),
    });
    // Evidence re-bound from replayed settled results; recovery state preserved.
    expect(rebuilt.getFailureEvidence("debug-retry")).toMatchObject({
      sourceTaskId: "verify-initial",
      sourceAttempt: 1,
      command: "retry-defect-check",
      exitCode: 7,
      outputArtifact: "artifact://runner-diff/frozen-static/verify-initial-1",
    });
    expect(rebuilt.getTask("debug-retry").state).toBe("succeeded");
    expect(rebuilt.getSnapshot().state).toBe("verifying");
  });
});

/** Drive the frozen graph through the real pull loop with sim-shaped results. */
function drivePullPath(engine: MissionEngine): void {
  const descriptors = [
    planner().descriptor,
    implementer().descriptor,
    adapter("sim-verifier", ["verification"], false, async () => succeed("verify")).descriptor,
    debuggerWorker().descriptor,
  ];
  for (let guard = 0; guard < 20; guard += 1) {
    const assignment = engine.leaseReadyTask(descriptors, `claim-${guard}`, "runner-1");
    if (!assignment) break;
    const spec = assignment.task;
    const result: WorkerResult =
      spec.kind === "verification" && spec.id === "verify-initial"
        ? {
            status: "failed",
            summary: "Trusted runner verification checks did not pass.",
            diagnosis: "retry-defect-check exited 7",
            evidence: [
              {
                kind: "diff",
                label: "runner-observed-git-diff",
                uri: "artifact://runner-diff/frozen-static/verify-initial-1",
                summary: "1 changed path",
              },
            ],
            outputs: {},
          }
        : succeed(spec.id);
    engine.settleWorkerRun(assignment.workerRunId, assignment.attempt, result, "runner-1");
  }
}
