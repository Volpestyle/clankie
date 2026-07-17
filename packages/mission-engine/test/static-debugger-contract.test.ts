import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileDoctrine, type OrchestrationProfile } from "@clankie/doctrine";
import { MissionPlanSchema, type TaskSpec, type WorkerResult } from "@clankie/protocol";
import { StaticWorkerRouter, type WorkerAdapter } from "@clankie/worker-sdk";
import {
  DEBUGGER_CONTRACT_METADATA_KEY,
  FAILURE_EVIDENCE_METADATA_KEY,
  MissionEngine,
} from "../src/index.ts";

// VUH-828: static-plan debuggers get the same strict reproduced/repaired
// contract as programmatic addDebuggerTask, and the failure-evidence bridge
// consumes only runner-authored WorkerResult.failedCheck (no string parsing).

const profile: OrchestrationProfile = {
  schemaVersion: "1",
  id: "static-debugger-contract-test",
  description: "VUH-828 static debugger contract tests",
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

function frozenPlan() {
  const compiled = doctrine();
  return MissionPlanSchema.parse({
    missionId: "static-debugger-contract",
    goal: "static debugger contract",
    rationale: "Prove VUH-828 strict static-plan debugger contract and structured failed-check bridge.",
    profileHash: compiled.profileHash,
    successCriteria: ["debugger contract holds on the static bridge path"],
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

/** Failed verification with runner-authored structured failedCheck only. */
function structuredFailedVerification(command: string, exitCode: number): WorkerResult {
  return {
    status: "failed",
    summary: "Trusted runner verification checks did not pass.",
    // Deliberately odd diagnosis text that would break the old "exited N" parser
    // if the bridge still depended on it — structured field is the only source.
    diagnosis: `check ${command} reported non-zero status code=${exitCode} (free-form)`,
    failedCheck: { command, exitCode },
    evidence: [
      {
        kind: "diff",
        label: "runner-observed-git-diff",
        uri: "artifact://runner-diff/static-debugger-contract/verify-initial-1",
        summary: "1 changed path",
      },
    ],
    outputs: {},
  };
}

/** Diagnosis-only failure — the pre-VUH-828 shape that relied on string parsing. */
function diagnosisOnlyFailure(): WorkerResult {
  return {
    status: "failed",
    summary: "Trusted runner verification checks did not pass.",
    diagnosis: "retry-defect-check exited 7",
    evidence: [
      {
        kind: "diff",
        label: "runner-observed-git-diff",
        uri: "artifact://runner-diff/static-debugger-contract/verify-initial-1",
        summary: "1 changed path",
      },
    ],
    outputs: {},
  };
}

const planner = () => adapter("sim-planner", ["context"], false, async (c) => succeed(c.task.id));
const implementer = () =>
  adapter("sim-implementer", ["implementation"], true, async (c) => succeed(c.task.id));

describe("VUH-828 static-plan debugger contract + structured failed-check bridge", () => {
  it("rejects plan-authored failure evidence as a substitute for the runner carrier", async () => {
    const plan = frozenPlan();
    const debuggerTask = plan.tasks.find((candidate) => candidate.id === "debug-retry");
    if (!debuggerTask) throw new Error("Frozen plan is missing debug-retry");
    debuggerTask.metadata[FAILURE_EVIDENCE_METADATA_KEY] = {
      sourceTaskId: "verify-initial",
      sourceAttempt: 1,
      command: "prebound-check",
      exitCode: 13,
      outputArtifact: "artifact://untrusted-plan/prebound",
    };

    const engine = new MissionEngine(plan, doctrine(), { workspacePath: "/tmp" });
    const lazyDebugger = adapter("sim-debugger", ["debugging"], true, async (context) =>
      succeed(context.task.id),
    );
    const verifier = adapter("sim-verifier", ["verification"], false, async (context) =>
      context.task.id === "verify-initial"
        ? {
            status: "failed",
            summary: "failed",
            diagnosis: "diagnosis-only exited 99",
            evidence: [],
            outputs: {},
          }
        : succeed(context.task.id),
    );

    await engine.runUntilIdle(new StaticWorkerRouter([planner(), implementer(), verifier, lazyDebugger]));

    expect(engine.getTask("debug-retry").state).toBe("failed");
    expect(engine.getFailureEvidence("debug-retry")).toBeUndefined();
  });

  it("fails a static-plan debugger that settles without reproduced/repaired evidence", async () => {
    const engine = new MissionEngine(frozenPlan(), doctrine(), { workspacePath: "/tmp" });
    let sawDebuggerContract = false;
    const lazyDebugger = adapter("sim-debugger", ["debugging"], true, async (context) => {
      sawDebuggerContract = context.task.metadata[DEBUGGER_CONTRACT_METADATA_KEY] === true;
      expect(context.task.metadata[FAILURE_EVIDENCE_METADATA_KEY]).toMatchObject({
        command: "retry-defect-check",
        exitCode: 7,
      });
      // Claims success without debugger.reproduced / debugger.repaired / repair outputs.
      return succeed(context.task.id);
    });
    const verifier = adapter("sim-verifier", ["verification"], false, async (context) =>
      context.task.id === "verify-initial"
        ? structuredFailedVerification("retry-defect-check", 7)
        : succeed(context.task.id),
    );
    await engine.runUntilIdle(new StaticWorkerRouter([planner(), implementer(), verifier, lazyDebugger]));

    expect(sawDebuggerContract).toBe(true);
    expect(engine.getTask("verify-initial").state).toBe("failed");
    // Same contractFailure message as programmatic addDebuggerTask.
    expect(engine.getTask("debug-retry").state).toBe("failed");
    expect(engine.getTask("debug-retry").result?.summary).toContain(
      "missing exact-check reproduction and before/after repair evidence",
    );
    // Repair re-verify never readies when the debugger fails the contract.
    expect(engine.getTask("verify-repair").state).toBe("queued");
    expect(engine.getSnapshot().state).toBe("failed");
  });

  it("binds failure evidence from structured failedCheck and ignores diagnosis format", async () => {
    const engine = new MissionEngine(frozenPlan(), doctrine(), { workspacePath: "/tmp" });
    const debuggerWorker = adapter("sim-debugger", ["debugging"], true, async (context) => {
      const failure = context.task.metadata[FAILURE_EVIDENCE_METADATA_KEY] as {
        command: string;
        exitCode: number;
        outputArtifact: string;
      };
      context.emit({
        type: "debugger.reproduced",
        missionId: context.missionId,
        taskId: context.task.id,
        workerRunId: context.workerRunId,
        profileHash: context.profileHash,
        data: {
          command: failure.command,
          exitCode: failure.exitCode,
          outputArtifact: "artifact://debug/reproduction",
        },
      });
      context.emit({
        type: "debugger.repaired",
        missionId: context.missionId,
        taskId: context.task.id,
        workerRunId: context.workerRunId,
        profileHash: context.profileHash,
        data: {
          before: ["artifact://candidate/before"],
          after: ["artifact://candidate/after"],
        },
      });
      return {
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
    });
    const verifier = adapter("sim-verifier", ["verification"], false, async (context) =>
      context.task.id === "verify-initial"
        ? structuredFailedVerification("structured-only-check", 42)
        : succeed(context.task.id),
    );
    await engine.runUntilIdle(new StaticWorkerRouter([planner(), implementer(), verifier, debuggerWorker]));

    const bound = engine.getEvents().find((event) => event.type === "debugger.failure_evidence.bound");
    expect(bound?.data).toMatchObject({
      sourceTaskId: "verify-initial",
      command: "structured-only-check",
      exitCode: 42,
      boundAtRuntime: true,
    });
    expect(engine.getFailureEvidence("debug-retry")).toMatchObject({
      command: "structured-only-check",
      exitCode: 42,
    });
    expect(engine.getTask("debug-retry").state).toBe("succeeded");
    expect(engine.getTask("verify-repair").state).toBe("succeeded");
  });

  it("does not bind evidence from diagnosis text alone (string parser removed)", async () => {
    const engine = new MissionEngine(frozenPlan(), doctrine(), { workspacePath: "/tmp" });
    const debuggerWorker = adapter("sim-debugger", ["debugging"], true, async (c) => succeed(c.task.id));
    const verifier = adapter("sim-verifier", ["verification"], false, async (context) =>
      context.task.id === "verify-initial" ? diagnosisOnlyFailure() : succeed(context.task.id),
    );
    await engine.runUntilIdle(new StaticWorkerRouter([planner(), implementer(), verifier, debuggerWorker]));

    expect(engine.getTask("verify-initial").state).toBe("failed");
    // No structured failedCheck → no bridge bind → debugger stays queued.
    expect(engine.getTask("debug-retry").state).toBe("queued");
    expect(engine.getFailureEvidence("debug-retry")).toBeUndefined();
    expect(engine.getEvents().some((e) => e.type === "debugger.failure_evidence.bound")).toBe(false);
    const starve = engine.getEvents().find((e) => e.type === "task.debugger_evidence_starved");
    expect(starve?.taskId).toBe("debug-retry");
    expect(engine.getSnapshot().state).toBe("failed");
  });

  it("contains no diagnosis/exited-format parser in the mission-engine source", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../src/index.ts"), "utf8");
    expect(source).not.toMatch(/parseFailedRunnerCheck/);
    expect(source).not.toMatch(/matchExited/);
    expect(source).not.toMatch(/exited\s+\\?\(-?\\?\\d\+/);
    expect(source).toMatch(/structuredFailedCheck/);
    expect(source).toMatch(/failedCheck/);
  });

  it("recovers on the pull path when settlement carries structured failedCheck + repair evidence", () => {
    // VUH-828 counterpart to the VUH-827 pull-path recovery scenario — lives
    // here so packages/mission-engine/test/static-recovery.test.ts stays frozen.
    const engine = new MissionEngine(frozenPlan(), doctrine(), { workspacePath: "/tmp" });
    const descriptors = [
      planner().descriptor,
      implementer().descriptor,
      adapter("sim-verifier", ["verification"], false, async () => succeed("verify")).descriptor,
      adapter("sim-debugger", ["debugging"], true, async () => succeed("debug")).descriptor,
    ];
    for (let guard = 0; guard < 20; guard += 1) {
      const assignment = engine.leaseReadyTask(descriptors, `claim-${guard}`, "runner-1");
      if (!assignment) break;
      const spec = assignment.task;
      let result: WorkerResult;
      if (spec.kind === "verification" && spec.id === "verify-initial") {
        result = structuredFailedVerification("retry-defect-check", 7);
      } else if (spec.kind === "debugging") {
        result = {
          status: "succeeded",
          summary: `${spec.id} done`,
          evidence: [],
          outputs: {
            debuggerRepair: {
              reproduction: {
                command: "retry-defect-check",
                exitCode: 7,
                outputArtifact: "artifact://debug/reproduction",
              },
              before: ["artifact://candidate/before"],
              after: ["artifact://candidate/after"],
            },
          },
        };
      } else {
        result = succeed(spec.id);
      }
      engine.settleWorkerRun(assignment.workerRunId, assignment.attempt, result, "runner-1");
    }
    expect(engine.getTask("debug-retry").state).toBe("succeeded");
    expect(engine.getTask("verify-repair").state).toBe("succeeded");
    expect(engine.getFailureEvidence("debug-retry")).toMatchObject({
      sourceTaskId: "verify-initial",
      command: "retry-defect-check",
      exitCode: 7,
    });
    expect(engine.getTask("debug-retry").spec.metadata[DEBUGGER_CONTRACT_METADATA_KEY]).toBe(true);

    const rebuilt = new MissionEngine(frozenPlan(), doctrine(), {
      workspacePath: "/tmp",
      replayEvents: engine.getEvents(),
    });
    expect(rebuilt.getFailureEvidence("debug-retry")).toMatchObject({
      command: "retry-defect-check",
      exitCode: 7,
    });
    expect(rebuilt.getTask("debug-retry").state).toBe("succeeded");
  });

  it("pins the approved VUH-843 fixture migration and unchanged VUH-697 acceptance test", () => {
    // VUH-843 changes only the approved recovery fixtures in commit 1; VUH-697
    // remains byte-identical to main. Keep both acceptance anchors pinned here.
    const here = dirname(fileURLToPath(import.meta.url));
    const hash = (name: string) =>
      createHash("sha256")
        .update(readFileSync(join(here, name)))
        .digest("hex");
    expect(hash("static-recovery.test.ts")).toBe(
      "1f826ffd0f0999bbcf4948b117f48b182e72e7aa2fc569e4d8bbf497460f14e8",
    );
    expect(hash("verifier-flow.test.ts")).toBe(
      "c29f6d0f88f4e60f34bbf057ea1994b2615e79fd4c1553fc27e798cee4c8a659",
    );
  });
});
