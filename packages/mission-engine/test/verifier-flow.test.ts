import { describe, expect, it } from "vitest";
import { compileDoctrine, type OrchestrationProfile } from "@clankie/doctrine";
import { MissionPlanSchema, type TaskSpec, type WorkerResult } from "@clankie/protocol";
import { StaticWorkerRouter, type WorkerAdapter, type WorkerRouter } from "@clankie/worker-sdk";
import {
  DEBUGGER_CONTRACT_METADATA_KEY,
  VERIFICATION_CONTRACT_METADATA_KEY,
  MissionEngine,
  type FailureEvidence,
} from "../src/index.ts";

const profile: OrchestrationProfile = {
  schemaVersion: "1",
  id: "verifier-flow-test",
  description: "Verifier and debugger flow tests",
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
    executionClass: "automatic",
    risk: "low",
    writeScope: ["src/**"],
    successCriteria: [`${id} is complete`],
    evidenceRequirements: [`Evidence for ${id}`],
    maxAttempts: 1,
    metadata: {},
    ...overrides,
  };
}

function plan(tasks: TaskSpec[]) {
  const compiled = doctrine();
  return MissionPlanSchema.parse({
    missionId: "verifier-flow",
    goal: "enforce the verification recovery chain",
    rationale: "The scheduler must preserve independent attribution and evidence provenance.",
    profileHash: compiled.profileHash,
    successCriteria: ["verification is independent and recovery is evidenced"],
    tasks,
  });
}

function descriptor(id: string, kinds: Array<TaskSpec["kind"]>, canWrite = true): WorkerAdapter {
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
    async run(): Promise<WorkerResult> {
      return { status: "succeeded", summary: `${id} done`, evidence: [], outputs: {} };
    },
  };
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length < 2) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]),
  );
}

function implementationThenReplan(workers: readonly ReturnType<typeof descriptor>[]) {
  const compiled = doctrine();
  const engine = new MissionEngine(plan([task("implement", { maxAttempts: 3 })]), compiled, {
    workspacePath: "/tmp",
  });
  const builders = workers
    .filter((worker) => worker.descriptor.id.startsWith("builder-"))
    .sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id));
  const first = engine.leaseReadyTask(
    builders.map((worker) => worker.descriptor),
    "implementation-1",
  );
  expect(first?.worker.id).toBe("builder-a");
  engine.expireWorkerLease("implement", first?.workerRunId ?? "missing", "retry after first worker loss");
  const second = engine.leaseReadyTask(
    builders.map((worker) => worker.descriptor),
    "implementation-2",
  );
  expect(second?.worker.id).toBe("builder-a");
  engine.expireWorkerLease("implement", second?.workerRunId ?? "missing", "retry after second worker loss");
  const third = engine.leaseReadyTask(
    builders.filter((worker) => worker.descriptor.id !== "builder-a").map((worker) => worker.descriptor),
    "implementation-3",
  );
  expect(third?.worker.id).toBe("builder-b");
  engine.settleWorkerRun(third?.workerRunId ?? "missing", third?.attempt ?? 0, {
    status: "succeeded",
    summary: "candidate written",
    evidence: [],
    outputs: {},
  });

  const verification = task("verify-after-replan", {
    title: "Verify after replan",
    objective: "Run unchanged acceptance checks and hunt counterexamples.",
    kind: "verification",
    role: "verifier",
    dependsOn: ["implement"],
    writeScope: [],
    successCriteria: ["acceptance checks pass"],
    evidenceRequirements: ["exact check evidence"],
  });
  engine.addTask(verification);
  return { engine, workers };
}

describe("mission-engine verifier and debugger flow", () => {
  it("never assigns a verifier to any implementing worker across retries and replanning", () => {
    const candidates = [
      descriptor("builder-a", ["implementation", "verification"]),
      descriptor("builder-b", ["implementation", "verification"]),
      descriptor("reviewer", ["verification"], false),
    ];
    for (const order of permutations(candidates)) {
      const { engine } = implementationThenReplan(order);
      const assignment = engine.leaseReadyTask(
        order.map((worker) => worker.descriptor),
        `verification-${order.map((worker) => worker.descriptor.id).join("-")}`,
      );
      expect(assignment?.worker.id).toBe("reviewer");
      expect(engine.getTask("implement").workerIds).toEqual(["builder-a", "builder-b"]);
      expect(engine.getEvents()).toContainEqual(
        expect.objectContaining({
          type: "task.started",
          taskId: "verify-after-replan",
          data: expect.objectContaining({ verification: expect.objectContaining({ phase: "initial" }) }),
        }),
      );
    }
  });

  it("rejects a router that ignores the scheduler's verifier exclusion set", async () => {
    const compiled = doctrine();
    const engine = new MissionEngine(
      plan([
        task("implement"),
        task("verify", {
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          writeScope: [],
          successCriteria: ["checks pass"],
          evidenceRequirements: ["check result"],
        }),
      ]),
      compiled,
      { workspacePath: "/tmp" },
    );
    const builder = descriptor("builder", ["implementation", "verification"]);
    const hostileRouter: WorkerRouter = {
      select: () => builder,
    };
    await engine.runUntilIdle(hostileRouter);
    expect(engine.getTask("verify")).toMatchObject({ state: "blocked" });
    expect(engine.getEvents()).toContainEqual(
      expect.objectContaining({
        type: "task.blocked",
        taskId: "verify",
        data: expect.objectContaining({ reason: expect.stringContaining("excluded worker builder") }),
      }),
    );
    expect(
      engine.getEvents().some((event) => event.type === "worker.started" && event.taskId === "verify"),
    ).toBe(false);
  });

  it("gives a verifier the acceptance contract and emits read-only semantic transitions", async () => {
    const compiled = doctrine();
    let observedMetadata: Record<string, unknown> | undefined;
    const verifier = descriptor("reviewer", ["verification"], false);
    verifier.run = async (context) => {
      observedMetadata = context.task.metadata;
      return { status: "succeeded", summary: "checks passed", evidence: [], outputs: {} };
    };
    const engine = new MissionEngine(
      plan([
        task("implement"),
        task("verify", {
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          writeScope: [],
          successCriteria: ["the exact acceptance checks pass", "counterexamples are considered"],
          evidenceRequirements: ["command and output artifact"],
        }),
      ]),
      compiled,
      { workspacePath: "/tmp" },
    );
    await engine.runUntilIdle(new StaticWorkerRouter([descriptor("builder", ["implementation"]), verifier]));
    expect(observedMetadata?.[VERIFICATION_CONTRACT_METADATA_KEY]).toEqual({
      acceptanceCriteria: ["the exact acceptance checks pass", "counterexamples are considered"],
      requiredChecks: ["typecheck", "unit"],
      unchangedAcceptanceChecks: true,
      huntsCounterexamples: true,
      readOnly: true,
    });
    expect(engine.getEvents()).toContainEqual(
      expect.objectContaining({
        type: "task.started",
        taskId: "verify",
        data: expect.objectContaining({
          verification: expect.objectContaining({ readOnly: true, unchangedAcceptanceChecks: true }),
        }),
      }),
    );
    expect(engine.getEvents()).toContainEqual(
      expect.objectContaining({
        type: "task.succeeded",
        taskId: "verify",
        data: expect.objectContaining({
          verification: expect.objectContaining({ resultRecorded: true }),
        }),
      }),
    );
  });

  it("routes structured failure evidence through debugger, then re-verifies independently", async () => {
    const compiled = doctrine();
    const builder = descriptor("builder", ["implementation"]);
    const verifier = descriptor("reviewer", ["verification"], false);
    let verificationRuns = 0;
    verifier.run = async () => {
      verificationRuns += 1;
      return verificationRuns === 1
        ? {
            status: "failed",
            summary: "acceptance check failed",
            evidence: [{ kind: "test_report", label: "failure", summary: "pnpm test exited 1" }],
            outputs: {},
          }
        : { status: "succeeded", summary: "reverification passed", evidence: [], outputs: {} };
    };
    const debuggerWorker = descriptor("debugger", ["debugging"]);
    debuggerWorker.run = async (context) => {
      expect(context.task.metadata[DEBUGGER_CONTRACT_METADATA_KEY]).toBe(true);
      expect(context.task.metadata["missionEngine.failureEvidence"]).toMatchObject({
        command: "pnpm test",
        exitCode: 1,
        outputArtifact: "artifact://verify/failure",
      });
      context.emit({
        type: "debugger.reproduced",
        missionId: context.missionId,
        taskId: context.task.id,
        workerRunId: context.workerRunId,
        profileHash: context.profileHash,
        data: {
          command: "pnpm test",
          exitCode: 1,
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
      return { status: "succeeded", summary: "smallest causal fix applied", evidence: [], outputs: {} };
    };
    const engine = new MissionEngine(
      plan([
        task("implement"),
        task("verify", {
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          writeScope: [],
          successCriteria: ["pnpm test passes"],
          evidenceRequirements: ["exact command and output artifact"],
        }),
      ]),
      compiled,
      { workspacePath: "/tmp" },
    );
    const router = new StaticWorkerRouter([builder, verifier, debuggerWorker]);
    await engine.runUntilIdle(router);
    const failure: FailureEvidence = {
      sourceTaskId: "verify",
      sourceAttempt: 1,
      command: "pnpm test",
      exitCode: 1,
      outputArtifact: "artifact://verify/failure",
    };
    engine.addDebuggerTask(
      task("debug", {
        kind: "debugging",
        role: "debugger",
        dependsOn: ["verify"],
        writeScope: ["src/**"],
        successCriteria: ["the causal defect is repaired"],
        evidenceRequirements: ["reproduction plus before/after artifacts"],
      }),
      failure,
    );
    engine.addTask(
      task("reverify", {
        kind: "verification",
        role: "verifier",
        dependsOn: ["debug"],
        writeScope: [],
        successCriteria: ["the original command passes unchanged"],
        evidenceRequirements: ["exact command and output artifact"],
      }),
    );
    await engine.runUntilIdle(router);
    expect(engine.getTask("debug").state).toBe("succeeded");
    expect(engine.getTask("reverify").state).toBe("succeeded");
    expect(engine.getTask("reverify").workerId).toBe("reviewer");
    expect(engine.getEvents().map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "debugger.evidence.bound",
        "debugger.started",
        "debugger.reproduced",
        "debugger.repaired",
        "debugger.completed",
      ]),
    );
    expect(engine.getEvents()).toContainEqual(
      expect.objectContaining({
        type: "task.started",
        taskId: "reverify",
        data: expect.objectContaining({
          verification: expect.objectContaining({ phase: "reverification" }),
        }),
      }),
    );
    expect(engine.getEvents()).toContainEqual(
      expect.objectContaining({
        type: "task.succeeded",
        taskId: "reverify",
        data: expect.objectContaining({
          verification: expect.objectContaining({ resultRecorded: true }),
        }),
      }),
    );
  });

  it("excludes a non-implementation writer (design/planner) from verifying its own output", () => {
    const engine = new MissionEngine(
      plan([
        task("design-assets", { kind: "design", role: "planner", writeScope: ["assets/**"] }),
        task("verify-assets", {
          kind: "verification",
          role: "verifier",
          dependsOn: ["design-assets"],
          writeScope: [],
          successCriteria: ["assets match the fixture"],
          evidenceRequirements: ["review evidence"],
        }),
      ]),
      doctrine(),
      { workspacePath: "/tmp" },
    );
    const designer = descriptor("designer", ["design", "verification"]);
    const reviewer = descriptor("reviewer", ["verification"], false);
    const drawn = engine.leaseReadyTask([designer.descriptor], "design-1");
    expect(drawn?.worker.id).toBe("designer");
    engine.settleWorkerRun(drawn?.workerRunId ?? "missing", drawn?.attempt ?? 0, {
      status: "succeeded",
      summary: "assets drawn",
      evidence: [],
      outputs: {},
    });
    // The design worker has a non-empty write scope, so it may never verify its own output.
    expect(engine.leaseReadyTask([designer.descriptor], "verify-only-designer")).toBeUndefined();
    expect(engine.getTask("verify-assets").state).toBe("queued");
    expect(engine.getTask("design-assets").workerIds).toEqual(["designer"]);
    // An independent reviewer is still accepted.
    const verified = engine.leaseReadyTask([designer.descriptor, reviewer.descriptor], "verify-reviewer");
    expect(verified?.worker.id).toBe("reviewer");
  });

  it("emits an observable starve event once when only excluded workers are offered for verification", () => {
    const engine = new MissionEngine(
      plan([
        task("implement"),
        task("verify", {
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          writeScope: [],
          successCriteria: ["checks pass"],
          evidenceRequirements: ["check result"],
        }),
      ]),
      doctrine(),
      { workspacePath: "/tmp" },
    );
    const builder = descriptor("builder", ["implementation", "verification"]);
    const built = engine.leaseReadyTask([builder.descriptor], "impl-1");
    expect(built?.worker.id).toBe("builder");
    engine.settleWorkerRun(built?.workerRunId ?? "missing", built?.attempt ?? 0, {
      status: "succeeded",
      summary: "done",
      evidence: [],
      outputs: {},
    });
    // Offer only the implementing worker for verification, across repeated polls.
    expect(engine.leaseReadyTask([builder.descriptor], "verify-1")).toBeUndefined();
    expect(engine.leaseReadyTask([builder.descriptor], "verify-2")).toBeUndefined();
    const starves = engine
      .getEvents()
      .filter((event) => event.type === "task.verification_starved" && event.taskId === "verify");
    expect(starves).toHaveLength(1); // once per episode, not once per poll
    expect(starves[0]?.data).toMatchObject({ excludedWorkerIds: ["builder"] });
    // A non-excluded verifier recovers the task with no further starve noise.
    const reviewer = descriptor("reviewer", ["verification"], false);
    const verified = engine.leaseReadyTask([builder.descriptor, reviewer.descriptor], "verify-3");
    expect(verified?.worker.id).toBe("reviewer");
    expect(engine.getEvents().filter((event) => event.type === "task.verification_starved")).toHaveLength(1);
  });

  it("stays silent when no capable verifier is offered (availability starvation, not exclusion)", () => {
    const engine = new MissionEngine(
      plan([
        task("implement"),
        task("verify", {
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          writeScope: [],
          successCriteria: ["checks pass"],
          evidenceRequirements: ["check result"],
        }),
      ]),
      doctrine(),
      { workspacePath: "/tmp" },
    );
    const builder = descriptor("builder", ["implementation"]);
    const built = engine.leaseReadyTask([builder.descriptor], "impl-1");
    expect(built?.worker.id).toBe("builder");
    engine.settleWorkerRun(built?.workerRunId ?? "missing", built?.attempt ?? 0, {
      status: "succeeded",
      summary: "done",
      evidence: [],
      outputs: {},
    });
    // Offer only an implementation-capable spare that never touched this task: it is not
    // excluded, but it also cannot verify, so this is plain availability starvation.
    const spare = descriptor("spare-builder", ["implementation"]);
    expect(engine.leaseReadyTask([spare.descriptor], "verify-1")).toBeUndefined();
    expect(engine.getEvents().some((event) => event.type === "task.verification_starved")).toBe(false);
  });
});
