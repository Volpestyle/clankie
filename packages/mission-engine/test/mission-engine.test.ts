import { describe, expect, it } from "vitest";
import { compileDoctrine, type OrchestrationProfile } from "@clankie/doctrine";
import { MissionPlanSchema, type WorkerResult } from "@clankie/protocol";
import { StaticWorkerRouter, type WorkerAdapter } from "@clankie/worker-sdk";
import { MissionEngine, MissionPlanValidationError, RecoveryConflictError } from "../src/index.ts";

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

function worker(id: string, kinds: Array<"implementation" | "debugging" | "verification">): WorkerAdapter {
  return {
    descriptor: {
      id,
      displayName: id,
      harness: "simulated",
      capabilities: {
        kinds,
        canWrite: kinds.includes("implementation") || kinds.includes("debugging"),
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
  const unitCheckIdentity = `runner-check:unit:sha256:${"a".repeat(64)}`;
  it("rejects an invalid plan with evidence before accepting any mission state", () => {
    const doctrine = compileDoctrine([profile]);
    const invalidPlan = MissionPlanSchema.parse({
      missionId: "m-invalid",
      goal: "reject invalid execution",
      rationale: "the engine admission boundary must be deterministic",
      profileHash: doctrine.profileHash,
      successCriteria: ["no invalid mission state is created"],
      tasks: [
        {
          id: "one",
          title: "One",
          objective: "Depend on two",
          kind: "implementation",
          role: "implementer",
          dependsOn: ["two"],
          successCriteria: ["one completes"],
          evidenceRequirements: ["one evidence"],
        },
        {
          id: "two",
          title: "Two",
          objective: "Depend on one",
          kind: "implementation",
          role: "implementer",
          dependsOn: ["one"],
          successCriteria: ["two completes"],
          evidenceRequirements: ["two evidence"],
        },
      ],
    });

    expect(() => new MissionEngine(invalidPlan, doctrine, { workspacePath: "/tmp" })).toThrow(
      MissionPlanValidationError,
    );
    try {
      new MissionEngine(invalidPlan, doctrine, { workspacePath: "/tmp" });
    } catch (error) {
      expect((error as MissionPlanValidationError).evidence).toMatchObject({
        valid: false,
        missionId: "m-invalid",
        issues: [expect.objectContaining({ code: "cycle", taskIds: ["one", "two"] })],
      });
    }
  });

  it("leases, records, settles, and replays pull worker attempts idempotently", () => {
    const doctrine = compileDoctrine([profile]);
    const plan = MissionPlanSchema.parse({
      missionId: "m-pull",
      goal: "run a retained candidate",
      rationale: "exercise the runner pull boundary",
      profileHash: doctrine.profileHash,
      successCriteria: ["implementation and verification settle"],
      assumptions: ["the runner retains claims for active attempts"],
      risks: ["a stale claim could settle the wrong task"],
      humanDecisionsRequired: ["approve execution before the mission starts"],
      plannedActions: [
        {
          id: "run-checks",
          taskId: "verify",
          action: "execute repository checks",
          resource: { type: "workspace", id: "test-workspace" },
          rationale: "verification requires deterministic evidence",
        },
      ],
      tasks: [
        {
          id: "implement",
          title: "Implement",
          objective: "write the candidate",
          kind: "implementation",
          role: "implementer",
          writeScope: ["src/**"],
          successCriteria: ["candidate exists"],
          evidenceRequirements: ["diff"],
        },
        {
          id: "verify",
          title: "Verify",
          objective: "inspect the candidate",
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          successCriteria: ["candidate passes"],
          evidenceRequirements: ["test report"],
        },
      ],
    });
    let id = 0;
    const engine = new MissionEngine(plan, doctrine, {
      workspacePath: "/tmp",
      idFactory: () => `id-${++id}`,
    });
    expect(engine.getSnapshot().planReview).toMatchObject({
      assumptions: ["the runner retains claims for active attempts"],
      risks: ["a stale claim could settle the wrong task"],
      humanDecisionsRequired: ["approve execution before the mission starts"],
      plannedActions: [expect.objectContaining({ id: "run-checks", taskId: "verify" })],
      validation: {
        valid: true,
        taskCount: 2,
        plannedActionIds: ["run-checks"],
        issues: [],
      },
    });
    const implementer = worker("codex-implementer", ["implementation"]).descriptor;
    const verifier = worker("codex-verifier", ["verification"]).descriptor;

    const assignment = engine.leaseReadyTask([implementer, verifier], "runner:claim-1");
    expect(assignment).toMatchObject({ task: { id: "implement" }, attempt: 1 });
    expect(engine.leaseReadyTask([implementer, verifier], "runner:claim-1")).toEqual(assignment);
    expect(engine.getEvents().filter((event) => event.type === "worker.leased")).toHaveLength(1);
    expect(() =>
      engine.heartbeatWorkerRun(assignment?.workerRunId ?? "missing", 1, "different-runner"),
    ).toThrow(/belongs to runner local/u);

    const event = engine.recordWorkerEvent({
      workerRunId: assignment?.workerRunId ?? "missing",
      attempt: 1,
      eventId: "provider-event-1",
      type: "worker.command.completed",
      data: { command: "pnpm test", exitCode: 0 },
    });
    expect(
      engine.recordWorkerEvent({
        workerRunId: assignment?.workerRunId ?? "missing",
        attempt: 1,
        eventId: "provider-event-1",
        type: "worker.command.completed",
        data: { command: "ignored duplicate", exitCode: 1 },
      }),
    ).toEqual(event);

    engine.recordWorkerEvent({
      workerRunId: assignment?.workerRunId ?? "missing",
      attempt: 1,
      eventId: "provider-event-waiting",
      type: "worker.waiting_user",
      data: {
        state: "waiting_user",
        source: "codex.app_server",
        tier: 0,
        confidence: 1,
        observedAt: "2026-07-11T12:00:00.000Z",
        questionSummary: "Approve the command?",
      },
    });
    expect(engine.getTask("implement").state).toBe("waiting_user");
    expect(engine.getSnapshot().state).toBe("blocked");

    engine.recordWorkerEvent({
      workerRunId: assignment?.workerRunId ?? "missing",
      attempt: 1,
      eventId: "provider-event-resumed",
      type: "worker.turn.started",
      data: {
        state: "working",
        source: "codex.app_server",
        tier: 0,
        confidence: 1,
        observedAt: "2026-07-11T12:00:01.000Z",
      },
    });
    expect(engine.getTask("implement").state).toBe("running");
    expect(engine.getSnapshot().state).toBe("running");

    engine.recordWorkerEvent({
      workerRunId: assignment?.workerRunId ?? "missing",
      attempt: 1,
      eventId: "provider-event-tier-2-attention",
      type: "worker.status.signal",
      data: {
        state: "waiting_user",
        source: "settle-classifier",
        tier: 2,
        confidence: 0.82,
        observedAt: "2026-07-11T12:00:02.000Z",
        questionSummary: "Choose a recovery path",
      },
    });
    expect(engine.explainWorkerStatus(assignment?.workerRunId ?? "missing")).toMatchObject({
      state: "working",
      basis: "turn_started",
      winner: { tier: 0 },
      attention: [
        expect.objectContaining({
          state: "waiting_user",
          tier: 2,
          disposition: "attention_only",
        }),
      ],
    });
    expect(
      engine.getEvents().findLast((candidate) => candidate.type === "worker.status.resolved")?.data,
    ).toMatchObject({
      state: "working",
      basis: "turn_started",
      tier: 0,
      source: "codex.app_server",
      confidence: 1,
      observedAt: "2026-07-11T12:00:01.000Z",
      attentionRaised: true,
      attention: [expect.objectContaining({ questionSummary: "Choose a recovery path" })],
    });
    expect(engine.getTask("implement").state).toBe("running");

    engine.recordWorkerEvent({
      workerRunId: assignment?.workerRunId ?? "missing",
      attempt: 1,
      eventId: "provider-event-turn-settled",
      type: "worker.turn.settled",
      data: {
        state: "idle",
        source: "codex.app_server",
        tier: 0,
        confidence: 1,
        observedAt: "2026-07-11T12:00:03.000Z",
      },
    });
    expect(engine.explainWorkerStatus(assignment?.workerRunId ?? "missing")).toMatchObject({
      state: "idle",
      basis: "turn_settled",
      winner: { tier: 0 },
    });
    // A settled turn is presentation-idle while its worker task remains active.
    expect(engine.getTask("implement").state).toBe("running");

    const result: WorkerResult = {
      status: "succeeded",
      summary: "candidate written",
      evidence: [{ kind: "diff", label: "candidate", summary: "one changed file" }],
      outputs: {},
    };
    expect(engine.settleWorkerRun(assignment?.workerRunId ?? "missing", 1, result).state).toBe("succeeded");
    expect(engine.explainWorkerStatus(assignment?.workerRunId ?? "missing")).toMatchObject({
      state: "completed",
      basis: "worker_settled",
      winner: { tier: 1, source: "mission-engine.settlement" },
    });
    expect(engine.settleWorkerRun(assignment?.workerRunId ?? "missing", 1, result).state).toBe("succeeded");
    expect(engine.getEvents().filter((candidate) => candidate.type === "worker.settled")).toHaveLength(1);
    expect(engine.leaseReadyTask([implementer, verifier], "runner:claim-1")).toBeUndefined();

    const replayed = new MissionEngine(plan, doctrine, {
      workspacePath: "/tmp",
      replayEvents: engine.getEvents(),
    });
    expect(replayed.getTask("implement")).toMatchObject({ state: "succeeded", result });
    expect(replayed.explainWorkerStatus(assignment?.workerRunId ?? "missing")).toEqual(
      engine.explainWorkerStatus(assignment?.workerRunId ?? "missing"),
    );
    expect(
      replayed.recordWorkerEvent({
        workerRunId: assignment?.workerRunId ?? "missing",
        attempt: 1,
        eventId: "provider-event-1",
        type: "worker.command.completed",
        data: { command: "ignored replay", exitCode: 1 },
      }),
    ).toEqual(event);
    const verification = replayed.leaseReadyTask([implementer, verifier], "runner:claim-2");
    expect(verification).toMatchObject({ task: { id: "verify" }, worker: { id: "codex-verifier" } });
  });

  it("keeps an active claim with its owner and requeues the exact abandoned attempt after expiry", () => {
    const doctrine = compileDoctrine([profile]);
    const plan = MissionPlanSchema.parse({
      missionId: "m-expiry",
      goal: "recover an abandoned claim",
      rationale: "lease recovery must be deterministic",
      profileHash: doctrine.profileHash,
      successCriteria: ["attempt is requeued"],
      tasks: [
        {
          id: "implement",
          title: "Implement",
          objective: "write candidate",
          kind: "implementation",
          role: "implementer",
          maxAttempts: 2,
          writeScope: ["src/**"],
          successCriteria: ["done"],
          evidenceRequirements: ["diff"],
        },
      ],
    });
    let now = new Date("2026-07-11T00:00:00.000Z");
    const engine = new MissionEngine(plan, doctrine, {
      workspacePath: "/tmp",
      clock: () => now,
    });
    const implementer = worker("codex-implementer", ["implementation"]).descriptor;
    const first = engine.leaseReadyTask([implementer], "runner-a:claim", "runner-a", 1_000);
    expect(first).toMatchObject({ attempt: 1, runnerId: "runner-a" });
    expect(engine.leaseReadyTask([implementer], "runner-b:claim", "runner-b", 1_000)).toBeUndefined();

    now = new Date("2026-07-11T00:00:02.000Z");
    expect(engine.expireAbandonedWorkerRuns()).toEqual([
      expect.objectContaining({ state: "queued", attempts: 1 }),
    ]);
    const recovered = engine.leaseReadyTask([implementer], "runner-b:retry", "runner-b", 1_000);
    expect(recovered).toMatchObject({ attempt: 2, runnerId: "runner-b" });
  });

  it("binds provider session events to the engine-issued worker run ID", async () => {
    const doctrine = compileDoctrine([profile]);
    const plan = MissionPlanSchema.parse({
      missionId: "m-native-session",
      goal: "preserve identity",
      rationale: "provider events require trusted run identity",
      profileHash: doctrine.profileHash,
      successCriteria: ["identity is preserved"],
      tasks: [
        {
          id: "native",
          title: "Bind session",
          objective: "Emit a provider session event",
          kind: "implementation",
          role: "implementer",
          successCriteria: ["session is bound"],
          evidenceRequirements: ["session event"],
        },
      ],
    });
    const adapter: WorkerAdapter = {
      ...worker("native", ["implementation"]),
      async run(context): Promise<WorkerResult> {
        context.emit({
          type: "worker.native_session.bound",
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: "provider-controlled-id",
          profileHash: context.profileHash,
          data: { nativeSessionId: "session-1" },
        });
        return { status: "succeeded", summary: "done", evidence: [], outputs: {} };
      },
    };
    const engine = new MissionEngine(plan, doctrine, { workspacePath: "/tmp" });
    await engine.runUntilIdle(new StaticWorkerRouter([adapter]));
    const started = engine.getEvents().find((event) => event.type === "worker.started");
    const bound = engine.getEvents().find((event) => event.type === "worker.native_session.bound");
    expect(bound?.workerRunId).toBe(started?.workerRunId);
    expect(bound?.workerRunId).not.toBe("provider-controlled-id");
    expect(bound?.data).toEqual({ nativeSessionId: "session-1" });
  });

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
          role: "implementer",
          successCriteria: ["done"],
          evidenceRequirements: ["Implementation evidence is attached."],
        },
        {
          id: "verify",
          title: "Verify",
          objective: "Verify",
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          successCriteria: ["passes"],
          evidenceRequirements: ["Verification evidence is attached."],
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

  it("requeues a running task with attempts remaining when its worker lease expires", async () => {
    const doctrine = compileDoctrine([profile]);
    const plan = MissionPlanSchema.parse({
      missionId: "m2",
      goal: "test",
      rationale: "test",
      profileHash: doctrine.profileHash,
      successCriteria: ["done"],
      tasks: [
        {
          id: "long",
          title: "Long task",
          objective: "Run long",
          kind: "implementation",
          role: "implementer",
          maxAttempts: 2,
          successCriteria: ["done"],
          evidenceRequirements: ["Completion evidence is attached."],
        },
      ],
    });
    const engine = new MissionEngine(plan, doctrine, { workspacePath: "/tmp" });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const hanging: WorkerAdapter = {
      ...worker("hanging", ["implementation"]),
      async run(): Promise<WorkerResult> {
        await gate;
        return { status: "succeeded", summary: "done", evidence: [], outputs: {} };
      },
    };
    const inFlight = engine.runReadyTasks(new StaticWorkerRouter([hanging]));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(engine.getTask("long").state).toBe("running");
    const workerRunId = engine.getTask("long").workerRunId;
    expect(workerRunId).toBeDefined();

    const requeued = engine.expireWorkerLease("long", workerRunId ?? "missing", "heartbeat expired");
    expect(requeued.state).toBe("queued");
    expect(requeued.workerId).toBeUndefined();
    // Idempotent once the task is no longer leased/running: no duplicate events.
    expect(engine.expireWorkerLease("long", workerRunId ?? "missing", "again").state).toBe("queued");
    const requeueEvents = engine.getEvents().filter((event) => event.type === "task.requeued");
    expect(requeueEvents).toHaveLength(1);
    expect(requeueEvents[0]?.data).toMatchObject({ reason: "heartbeat expired" });

    release?.();
    await inFlight;
    // The zombie worker's late result must not overwrite the recovered state.
    expect(engine.getTask("long").state).toBe("queued");
    expect(engine.getEvents().some((event) => event.type === "worker.result.discarded")).toBe(true);
    expect(engine.getEvents().some((event) => event.type === "task.succeeded")).toBe(false);
  });

  it("fails a task explicitly when its lease expires with no attempts remaining", async () => {
    const doctrine = compileDoctrine([profile]);
    const plan = MissionPlanSchema.parse({
      missionId: "m3",
      goal: "test",
      rationale: "test",
      profileHash: doctrine.profileHash,
      successCriteria: ["done"],
      tasks: [
        {
          id: "only-try",
          title: "Single attempt",
          objective: "Run once",
          kind: "implementation",
          role: "implementer",
          successCriteria: ["done"],
          evidenceRequirements: ["Completion evidence is attached."],
        },
      ],
    });
    const engine = new MissionEngine(plan, doctrine, { workspacePath: "/tmp" });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const hanging: WorkerAdapter = {
      ...worker("hanging", ["implementation"]),
      async run(): Promise<WorkerResult> {
        await gate;
        return { status: "succeeded", summary: "done", evidence: [], outputs: {} };
      },
    };
    const inFlight = engine.runReadyTasks(new StaticWorkerRouter([hanging]));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    const workerRunId = engine.getTask("only-try").workerRunId;
    expect(workerRunId).toBeDefined();

    const failed = engine.expireWorkerLease("only-try", workerRunId ?? "missing", "worker lost");
    expect(failed.state).toBe("failed");
    expect(failed.result?.diagnosis).toBe("worker lost");
    expect(engine.getSnapshot().state).toBe("failed");
    expect(engine.getEvents().some((event) => event.type === "task.failed")).toBe(true);

    release?.();
    await inFlight;
  });

  it("ignores a delayed expiry callback from an earlier worker attempt", async () => {
    const doctrine = compileDoctrine([profile]);
    const plan = MissionPlanSchema.parse({
      missionId: "m4",
      goal: "test",
      rationale: "test",
      profileHash: doctrine.profileHash,
      successCriteria: ["done"],
      tasks: [
        {
          id: "retried",
          title: "Retried task",
          objective: "Survive a stale expiry callback",
          kind: "implementation",
          role: "implementer",
          maxAttempts: 2,
          successCriteria: ["done"],
          evidenceRequirements: ["Completion evidence is attached."],
        },
      ],
    });
    const engine = new MissionEngine(plan, doctrine, { workspacePath: "/tmp" });
    const releases: Array<() => void> = [];
    const retrying: WorkerAdapter = {
      ...worker("retrying", ["implementation"]),
      async run(): Promise<WorkerResult> {
        await new Promise<void>((resolvePromise) => releases.push(resolvePromise));
        return { status: "succeeded", summary: "done", evidence: [], outputs: {} };
      },
    };
    const router = new StaticWorkerRouter([retrying]);

    const firstAttempt = engine.runReadyTasks(router);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    const firstWorkerRunId = engine.getTask("retried").workerRunId;
    expect(firstWorkerRunId).toBeDefined();
    engine.expireWorkerLease("retried", firstWorkerRunId ?? "missing", "first attempt expired");

    const secondAttempt = engine.runReadyTasks(router);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    const secondWorkerRunId = engine.getTask("retried").workerRunId;
    expect(secondWorkerRunId).toBeDefined();
    expect(secondWorkerRunId).not.toBe(firstWorkerRunId);

    const afterStaleExpiry = engine.expireWorkerLease(
      "retried",
      firstWorkerRunId ?? "missing",
      "delayed first-attempt callback",
    );
    expect(afterStaleExpiry).toMatchObject({ state: "running", workerRunId: secondWorkerRunId });
    expect(engine.getEvents().filter((event) => event.type === "worker.lease.expiry.discarded")).toHaveLength(
      1,
    );
    expect(engine.getEvents().some((event) => event.type === "task.failed")).toBe(false);

    releases[0]?.();
    releases[1]?.();
    await Promise.all([firstAttempt, secondAttempt]);
    expect(engine.getTask("retried").state).toBe("succeeded");
  });

  it("honors recovery exclusions on direct execution and reuses only the independent verifier", async () => {
    const doctrine = compileDoctrine([profile]);
    const plan = MissionPlanSchema.parse({
      missionId: "m-direct-recovery",
      goal: "repair without reusing either causal writer",
      rationale: "direct execution must enforce the same recovery routing as pull leasing",
      profileHash: doctrine.profileHash,
      successCriteria: ["unchanged verification passes"],
      tasks: [
        {
          id: "implement",
          title: "Implement",
          objective: "write candidate",
          kind: "implementation",
          role: "implementer",
          writeScope: ["src/**"],
          successCriteria: ["candidate exists"],
          evidenceRequirements: ["diff"],
        },
        {
          id: "verify",
          title: "Verify",
          objective: "run checks",
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          successCriteria: ["checks pass"],
          evidenceRequirements: ["test report"],
        },
      ],
    });
    const directWorker = (
      id: string,
      kinds: Array<"implementation" | "debugging" | "verification">,
      result: WorkerResult,
    ): WorkerAdapter => ({
      ...worker(id, kinds),
      run: () => Promise.resolve(structuredClone(result)),
    });
    const originalBuilder = directWorker("codex-implementation", ["implementation", "debugging"], {
      status: "succeeded",
      summary: "candidate",
      evidence: [],
      outputs: {},
    });
    let verificationAttempt = 0;
    const originalVerifier: WorkerAdapter = {
      ...worker("claude-verification", ["verification"]),
      run: () => {
        verificationAttempt += 1;
        return Promise.resolve({
          status: verificationAttempt === 1 ? "failed" : "succeeded",
          summary: verificationAttempt === 1 ? "unit failed" : "unit passed",
          evidence: [{ kind: "test_report", label: unitCheckIdentity, summary: "trusted check" }],
          outputs: {},
          ...(verificationAttempt === 1 ? { diagnosis: "unit exited 1" } : {}),
        });
      },
    };
    const debuggerWorker = directWorker("pi-debugging", ["debugging"], {
      status: "succeeded",
      summary: "repaired",
      evidence: [],
      outputs: {},
    });
    const engine = new MissionEngine(plan, doctrine, { workspacePath: "/tmp" });
    const router = new StaticWorkerRouter([originalBuilder, originalVerifier, debuggerWorker]);

    await engine.runUntilIdle(router);
    expect(engine.getTask("verify")).toMatchObject({
      state: "failed",
      workerId: "claude-verification",
    });
    engine.addRecoveryPair({
      commandId: "direct-recovery",
      failedTaskId: "verify",
      debugger: MissionPlanSchema.parse({
        ...plan,
        tasks: [
          {
            id: "debug",
            title: "Debug",
            objective: "repair failure",
            kind: "debugging",
            role: "debugger",
            dependsOn: ["implement"],
            writeScope: ["src/**"],
            successCriteria: ["fixed"],
            evidenceRequirements: ["diff"],
          },
        ],
      }).tasks[0]!,
      reverify: MissionPlanSchema.parse({
        ...plan,
        tasks: [
          {
            id: "reverify",
            title: "Reverify",
            objective: "rerun unchanged check",
            kind: "verification",
            role: "verifier",
            dependsOn: ["debug"],
            successCriteria: ["passes"],
            evidenceRequirements: ["test report"],
          },
        ],
      }).tasks[0]!,
    });

    await engine.runUntilIdle(router);
    expect(engine.getTask("debug").workerId).toBe("pi-debugging");
    expect(engine.getTask("reverify").workerId).toBe("claude-verification");
    expect(engine.getTask("debug").workerId).not.toBe(engine.getTask("implement").workerId);
    expect(engine.getTask("debug").workerId).not.toBe(engine.getTask("verify").workerId);
  });

  it("persists one idempotent recovery pair and resolves a historical verifier failure", () => {
    const doctrine = compileDoctrine([profile]);
    const plan = MissionPlanSchema.parse({
      missionId: "m-recovery",
      goal: "repair a failed verification",
      rationale: "recovery must preserve the original failure and unchanged checks",
      profileHash: doctrine.profileHash,
      successCriteria: ["unchanged verification passes after debugging"],
      tasks: [
        {
          id: "implement",
          title: "Implement",
          objective: "write candidate",
          kind: "implementation",
          role: "implementer",
          writeScope: ["src/**"],
          successCriteria: ["candidate exists"],
          evidenceRequirements: ["diff"],
        },
        {
          id: "verify",
          title: "Verify",
          objective: "run trusted checks",
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          successCriteria: ["checks pass"],
          evidenceRequirements: ["test report"],
        },
      ],
    });
    let id = 0;
    const engine = new MissionEngine(plan, doctrine, {
      workspacePath: "/tmp",
      idFactory: () => `recovery-${++id}`,
    });
    const descriptor = (
      workerId: string,
      kinds: Array<"implementation" | "debugging" | "verification">,
      canWrite: boolean,
    ) => ({
      id: workerId,
      displayName: workerId,
      harness: "simulated" as const,
      capabilities: {
        kinds,
        canWrite,
        supportsStructuredEvents: true,
        supportsTerminal: false,
        supportsNativeSession: false,
      },
    });
    const workers = [
      descriptor("codex-implementation", ["implementation"], true),
      descriptor("claude-verification", ["verification"], false),
      descriptor("pi-debugging", ["debugging"], true),
    ];
    const implementation = engine.leaseReadyTask(workers, "claim-implement");
    engine.settleWorkerRun(implementation?.workerRunId ?? "missing", 1, {
      status: "succeeded",
      summary: "candidate",
      evidence: [{ kind: "diff", label: "candidate", summary: "changed src" }],
      outputs: {},
    });
    const verification = engine.leaseReadyTask(workers, "claim-verify");
    expect(verification?.worker.id).toBe("claude-verification");
    engine.settleWorkerRun(verification?.workerRunId ?? "missing", 1, {
      status: "failed",
      summary: "trusted checks failed",
      diagnosis: "unit exited 1",
      evidence: [
        { kind: "test_report", label: unitCheckIdentity, summary: "unit exited 1" },
        { kind: "log", label: "runner-check-output-metadata:unit", summary: "opaque hash" },
      ],
      outputs: {},
    });
    const recovery = {
      commandId: "recover-1",
      failedTaskId: "verify",
      debugger: MissionPlanSchema.parse({
        ...plan,
        tasks: [
          {
            id: "debug",
            title: "Debug",
            objective: "repair the observed unit failure",
            kind: "debugging",
            role: "debugger",
            dependsOn: ["implement"],
            writeScope: ["src/**"],
            successCriteria: ["root cause fixed"],
            evidenceRequirements: ["diff and diagnosis"],
          },
        ],
      }).tasks[0]!,
      reverify: MissionPlanSchema.parse({
        ...plan,
        tasks: [
          {
            id: "reverify",
            title: "Reverify",
            objective: "rerun unchanged trusted checks",
            kind: "verification",
            role: "verifier",
            dependsOn: ["debug"],
            successCriteria: ["the original check identity passes"],
            evidenceRequirements: ["test report"],
          },
        ],
      }).tasks[0]!,
    };
    expect(() =>
      engine.addRecoveryPair({
        ...recovery,
        debugger: { ...recovery.debugger, metadata: { recovery: { forged: true } } },
      }),
    ).toThrow(/reserved/u);
    const pair = engine.addRecoveryPair(recovery);
    expect(pair.debugger.spec.metadata).toMatchObject({
      recovery: {
        failedTaskId: "verify",
        diagnosis: "unit exited 1",
        requiredCheckIdentities: [unitCheckIdentity],
        testIntegrity: "unchanged",
      },
    });
    expect(engine.addRecoveryPair(recovery)).toEqual(pair);
    expect(engine.getEvents().filter((event) => event.type === "task.added")).toHaveLength(0);
    expect(engine.getEvents().find((event) => event.type === "recovery.pair.added")?.data).toMatchObject({
      debuggerSpec: { id: "debug", metadata: { recovery: { failedTaskId: "verify" } } },
      reverifySpec: { id: "reverify", metadata: { recovery: { failedTaskId: "verify" } } },
    });
    expect(() =>
      engine.addRecoveryPair({
        ...recovery,
        debugger: { ...recovery.debugger, title: "Conflicting debug" },
      }),
    ).toThrow(RecoveryConflictError);

    const debugging = engine.leaseReadyTask(workers, "claim-debug");
    expect(debugging).toMatchObject({ task: { id: "debug" }, worker: { id: "pi-debugging" } });
    engine.settleWorkerRun(debugging?.workerRunId ?? "missing", 1, {
      status: "succeeded",
      summary: "fixed",
      evidence: [{ kind: "diff", label: "fix", summary: "root cause repaired" }],
      outputs: {},
    });
    const reverification = engine.leaseReadyTask(workers, "claim-reverify");
    expect(reverification).toMatchObject({
      task: { id: "reverify" },
      worker: { id: "claude-verification" },
    });
    engine.settleWorkerRun(reverification?.workerRunId ?? "missing", 1, {
      status: "succeeded",
      summary: "unit passed",
      evidence: [{ kind: "test_report", label: unitCheckIdentity, summary: "unit exited 0" }],
      outputs: {},
    });
    engine.resolveFailedVerification("verify", "reverify");
    expect(engine.getTask("verify").state).toBe("failed");
    expect(engine.isReadyForCompletion()).toBe(true);
    engine.completeMission("Recovered with unchanged verification.");
    engine.completeMission("duplicate terminal request");
    expect(engine.getEvents().filter((event) => event.type === "mission.succeeded")).toHaveLength(1);

    const replayed = new MissionEngine(plan, doctrine, {
      workspacePath: "/tmp",
      replayEvents: engine.getEvents(),
    });
    expect(replayed.getSnapshot()).toMatchObject({
      state: "succeeded",
      eventCount: engine.getEvents().length,
    });
    expect(replayed.getTask("verify").state).toBe("failed");
    expect(replayed.getTask("debug").state).toBe("succeeded");
    expect(replayed.getTask("reverify").state).toBe("succeeded");
    expect(replayed.addRecoveryPair(recovery).requiredCheckIdentities).toEqual([unitCheckIdentity]);
  });
});
