import { compileDoctrine, type OrchestrationProfile } from "@clankie/doctrine";
import { MissionPlanSchema, type WorkerResult } from "@clankie/protocol";
import type { WorkerDescriptor } from "@clankie/worker-sdk";
import { describe, expect, it } from "vitest";
import { MissionEngine } from "../src/index.ts";

const profile: OrchestrationProfile = {
  schemaVersion: "1",
  id: "affinity-test",
  description: "Affinity test",
  planning: {
    requirePlanApproval: false,
    scopeExpansion: "ask",
    targetReviewMinutes: 20,
    softChangedLines: 300,
    hardChangedLines: 800,
    maxLogicalConcernsPerPr: 1,
  },
  topology: { maxParallelWorkers: 4, maxDelegationDepth: 2, defaultExecution: "runner_visible", route: [] },
  verification: {
    independentVerifier: true,
    differentHarnessPreferred: true,
    requireEvidence: true,
    requiredChecks: ["unit"],
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

const doctrine = compileDoctrine([profile]);

function descriptor(
  id: string,
  kinds: Array<"implementation" | "debugging" | "verification" | "review">,
  adoption?: { grade: "observed" | "directed"; writeScope: string[] },
): WorkerDescriptor {
  return {
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
    ...(adoption ? { adoption } : {}),
  };
}

interface TaskFixture {
  id: string;
  kind: "implementation" | "verification" | "review";
  role: "implementer" | "verifier" | "reviewer";
  writeScope?: string[];
  dependsOn?: string[];
  maxAttempts?: number;
}

function planWith(tasks: TaskFixture[], missionId = "m-affinity") {
  return MissionPlanSchema.parse({
    missionId,
    goal: "route work to the worker that already holds the context",
    rationale: "affinity must be deterministic",
    profileHash: doctrine.profileHash,
    successCriteria: ["the warm worker is chosen"],
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.id,
      objective: `do ${task.id}`,
      kind: task.kind,
      role: task.role,
      dependsOn: task.dependsOn ?? [],
      writeScope: task.writeScope ?? [],
      maxAttempts: task.maxAttempts ?? 1,
      successCriteria: ["done"],
      evidenceRequirements: ["diff"],
    })),
  });
}

function engineFor(tasks: TaskFixture[], missionId?: string): MissionEngine {
  let id = 0;
  return new MissionEngine(planWith(tasks, missionId), doctrine, {
    workspacePath: "/tmp",
    idFactory: () => `id-${String(++id)}`,
  });
}

const succeeded: WorkerResult = {
  status: "succeeded",
  summary: "done",
  evidence: [{ kind: "diff", label: "diff", summary: "changed" }],
  outputs: {},
};

describe("worker affinity", () => {
  it("prefers the worker that ran the previous attempt of the same task", () => {
    const engine = engineFor([
      { id: "implement", kind: "implementation", role: "implementer", maxAttempts: 2 },
    ]);
    // `beta` sorts after `alpha`, so first-match alone would never pick it.
    const workers = [descriptor("alpha", ["implementation"]), descriptor("beta", ["implementation"])];

    const first = engine.leaseReadyTask([workers[1]!], "claim-1");
    expect(first?.worker.id).toBe("beta");
    // A lease expiry is the path that returns a task to the queue with its
    // attempt history intact; a settled failure is terminal for the attempt.
    engine.expireWorkerLease("implement", first?.workerRunId ?? "missing", "beta went quiet");

    const retry = engine.leaseReadyTask(workers, "claim-2");

    expect(retry?.worker.id).toBe("beta");
    expect(retry?.attempt).toBe(2);
  });

  it("prefers the worker that completed a dependency", () => {
    const engine = engineFor([
      { id: "first", kind: "implementation", role: "implementer", writeScope: ["packages/a/**"] },
      {
        id: "second",
        kind: "implementation",
        role: "implementer",
        writeScope: ["packages/b/**"],
        dependsOn: ["first"],
      },
    ]);
    const zulu = descriptor("zulu", ["implementation"]);
    const alpha = descriptor("alpha", ["implementation"]);

    const first = engine.leaseReadyTask([zulu], "claim-1");
    expect(first?.task.id).toBe("first");
    engine.settleWorkerRun(first?.workerRunId ?? "missing", 1, succeeded);

    const second = engine.leaseReadyTask([alpha, zulu], "claim-2");

    expect(second?.task.id).toBe("second");
    expect(second?.worker.id).toBe("zulu");
  });

  it("prefers the worker warm on an overlapping write scope", () => {
    // Overlapping scopes must be sequenced, so the chain runs through `gate`.
    // That makes `gate`'s worker the direct-dependency signal and `first`'s the
    // scope signal, isolating scope warmth from dependency warmth.
    const engine = engineFor([
      { id: "first", kind: "implementation", role: "implementer", writeScope: ["packages/shared/**"] },
      { id: "gate", kind: "implementation", role: "implementer", dependsOn: ["first"] },
      {
        id: "second",
        kind: "implementation",
        role: "implementer",
        writeScope: ["packages/shared/**"],
        dependsOn: ["gate"],
      },
    ]);
    const zulu = descriptor("zulu", ["implementation"]);
    const alpha = descriptor("alpha", ["implementation"]);

    const first = engine.leaseReadyTask([zulu], "claim-1");
    expect(first?.task.id).toBe("first");
    engine.settleWorkerRun(first?.workerRunId ?? "missing", 1, succeeded);
    const gate = engine.leaseReadyTask([alpha], "claim-2");
    expect(gate?.task.id).toBe("gate");
    engine.settleWorkerRun(gate?.workerRunId ?? "missing", 1, succeeded);

    const second = engine.leaseReadyTask([alpha, zulu], "claim-3");

    expect(second?.task.id).toBe("second");
    // `alpha` is the dependency author (+2); `zulu` is scope-warm (+4).
    expect(second?.worker.id).toBe("zulu");
  });

  it("prefers an idle worker when neither is warm", () => {
    const engine = engineFor([
      { id: "first", kind: "implementation", role: "implementer", writeScope: ["packages/a/**"] },
      { id: "second", kind: "implementation", role: "implementer", writeScope: ["packages/b/**"] },
    ]);
    const alpha = descriptor("alpha", ["implementation"]);
    const beta = descriptor("beta", ["implementation"]);

    // alpha takes `first` and stays live, so beta is the only idle worker.
    const first = engine.leaseReadyTask([alpha], "claim-1");
    expect(first?.worker.id).toBe("alpha");

    const second = engine.leaseReadyTask([alpha, beta], "claim-2");

    expect(second?.task.id).toBe("second");
    expect(second?.worker.id).toBe("beta");
  });

  it("breaks ties lexicographically so identical missions make identical choices", () => {
    const workers = [
      descriptor("zulu", ["implementation"]),
      descriptor("alpha", ["implementation"]),
      descriptor("mike", ["implementation"]),
    ];

    const forward = engineFor([
      { id: "implement", kind: "implementation", role: "implementer" },
    ]).leaseReadyTask(workers, "claim-1");
    const reversed = engineFor([
      { id: "implement", kind: "implementation", role: "implementer" },
    ]).leaseReadyTask([...workers].reverse(), "claim-1");

    expect(forward?.worker.id).toBe("alpha");
    expect(reversed?.worker.id).toBe("alpha");
  });

  it("never lets warmth override verification independence", () => {
    const engine = engineFor([
      { id: "implement", kind: "implementation", role: "implementer", writeScope: ["src/**"] },
      { id: "verify", kind: "verification", role: "verifier", dependsOn: ["implement"] },
    ]);
    const writer = descriptor("writer", ["implementation", "verification"]);
    const independent = descriptor("zz-independent", ["verification"]);

    const implement = engine.leaseReadyTask([writer], "claim-1");
    engine.settleWorkerRun(implement?.workerRunId ?? "missing", 1, succeeded);

    const verify = engine.leaseReadyTask([writer, independent], "claim-2");

    // `writer` is the warmest candidate by every score, and still excluded.
    expect(verify?.task.id).toBe("verify");
    expect(verify?.worker.id).toBe("zz-independent");
  });
});

describe("adopted worker routing", () => {
  const adoptedDirected = descriptor("adopted-directed", ["implementation"], {
    grade: "directed",
    writeScope: ["packages/owned/**"],
  });

  it("never routes to an observed adoption", () => {
    const engine = engineFor([{ id: "implement", kind: "implementation", role: "implementer" }]);
    const observed = descriptor("adopted-observed", ["implementation"], {
      grade: "observed",
      writeScope: [],
    });

    expect(engine.leaseReadyTask([observed], "claim-1")).toBeUndefined();
  });

  it("never routes verification or review to an adopted worker", () => {
    const engine = engineFor([{ id: "review", kind: "review", role: "reviewer" }]);
    const adoptedReviewer = descriptor("adopted-reviewer", ["review"], {
      grade: "directed",
      writeScope: ["packages/owned/**"],
    });

    expect(engine.leaseReadyTask([adoptedReviewer], "claim-1")).toBeUndefined();
  });

  it("routes a task into the adopted worker that owns the path", () => {
    const engine = engineFor([
      {
        id: "implement",
        kind: "implementation",
        role: "implementer",
        writeScope: ["packages/owned/src/**"],
      },
    ]);
    const spawned = descriptor("aaa-spawned", ["implementation"]);

    const assignment = engine.leaseReadyTask([spawned, adoptedDirected], "claim-1");

    expect(assignment?.worker.id).toBe("adopted-directed");
  });

  it("holds a task back rather than routing around a live adopted writer", () => {
    const engine = engineFor([
      { id: "verify-owned", kind: "verification", role: "verifier" },
      {
        id: "implement",
        kind: "implementation",
        role: "implementer",
        writeScope: ["packages/owned/src/**"],
      },
    ]);
    // The adopted worker owns the path but may not run verification, and the
    // spawned worker may not enter a path a live adoption holds.
    const spawned = descriptor("spawned", ["implementation", "verification"]);
    const adoptedVerifierless = descriptor("adopted", ["verification"], {
      grade: "directed",
      writeScope: ["packages/owned/**"],
    });

    const assignment = engine.leaseReadyTask([spawned, adoptedVerifierless], "claim-1");
    // Only the scope-free verification task can proceed. The lease loop returns
    // on its first success, so the contended task is reached on the next poll.
    expect(assignment?.task.id).toBe("verify-owned");

    expect(engine.leaseReadyTask([spawned, adoptedVerifierless], "claim-2")).toBeUndefined();

    const contended = engine.getEvents().filter((event) => event.type === "task.scope_contended");
    expect(contended).toHaveLength(1);
    expect(contended[0]).toMatchObject({
      taskId: "implement",
      data: { adoptedWorkerIds: ["adopted"] },
    });
  });

  it("signals scope contention once per episode, not once per poll", () => {
    const engine = engineFor([
      {
        id: "implement",
        kind: "implementation",
        role: "implementer",
        writeScope: ["packages/owned/src/**"],
      },
    ]);
    const adoptedVerifierless = descriptor("adopted", ["verification"], {
      grade: "directed",
      writeScope: ["packages/owned/**"],
    });

    engine.leaseReadyTask([adoptedVerifierless], "claim-1");
    engine.leaseReadyTask([adoptedVerifierless], "claim-2");
    engine.leaseReadyTask([adoptedVerifierless], "claim-3");

    expect(engine.getEvents().filter((event) => event.type === "task.scope_contended")).toHaveLength(1);
  });

  it("leaves an unrelated write scope untouched by an adoption", () => {
    const engine = engineFor([
      { id: "implement", kind: "implementation", role: "implementer", writeScope: ["apps/other/**"] },
    ]);
    const spawned = descriptor("spawned", ["implementation"]);

    const assignment = engine.leaseReadyTask([spawned, adoptedDirected], "claim-1");

    expect(assignment?.worker.id).toBe("spawned");
    expect(engine.getEvents().filter((event) => event.type === "task.scope_contended")).toEqual([]);
  });
});
