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
  it("leases, records, settles, and replays pull worker attempts idempotently", () => {
    const doctrine = compileDoctrine([profile]);
    const plan = MissionPlanSchema.parse({
      missionId: "m-pull",
      goal: "run a retained candidate",
      rationale: "exercise the runner pull boundary",
      profileHash: doctrine.profileHash,
      successCriteria: ["implementation and verification settle"],
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

    const result: WorkerResult = {
      status: "succeeded",
      summary: "candidate written",
      evidence: [{ kind: "diff", label: "candidate", summary: "one changed file" }],
      outputs: {},
    };
    expect(engine.settleWorkerRun(assignment?.workerRunId ?? "missing", 1, result).state).toBe("succeeded");
    expect(engine.settleWorkerRun(assignment?.workerRunId ?? "missing", 1, result).state).toBe("succeeded");
    expect(engine.getEvents().filter((candidate) => candidate.type === "worker.settled")).toHaveLength(1);
    expect(engine.leaseReadyTask([implementer, verifier], "runner:claim-1")).toBeUndefined();

    const replayed = new MissionEngine(plan, doctrine, {
      workspacePath: "/tmp",
      replayEvents: engine.getEvents(),
    });
    expect(replayed.getTask("implement")).toMatchObject({ state: "succeeded", result });
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
});
