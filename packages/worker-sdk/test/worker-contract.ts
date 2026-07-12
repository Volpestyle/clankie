import type { DomainEvent } from "@clankie/protocol";
import type { WorkerAdapter, WorkerRunContext } from "../src/index.ts";
import { describe, expect, it } from "vitest";

type EmittedEvent = Omit<DomainEvent, "id" | "occurredAt" | "correlationId">;

export interface SuccessContractFixture {
  adapter: WorkerAdapter;
  assigned(): boolean;
  nativeSessionId: string | null;
  statusSource?: string;
}

export interface CancellationContractFixture {
  adapter: WorkerAdapter;
  nativeSessionId: string | null;
  started?: Promise<void>;
  cancellationForwarded?: () => boolean;
}

export function runWorkerAdapterContract(
  name: string,
  createSuccess: () => SuccessContractFixture,
  createCancellation: () => CancellationContractFixture,
): void {
  describe(`${name} worker contract`, () => {
    it("assigns a task, emits evidence, and preserves run/session identity", async () => {
      const fixture = createSuccess();
      const events: EmittedEvent[] = [];
      const result = await fixture.adapter.run(context(new AbortController().signal, events));

      expect(result.status).toBe("succeeded");
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.outputs.workerRunId).toBe("run-contract");
      expect(fixture.assigned()).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.workerRunId === "run-contract")).toBe(true);
      if (fixture.statusSource) {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "worker.turn.started",
            data: expect.objectContaining({
              state: "working",
              source: fixture.statusSource,
              tier: 0,
              confidence: 1,
              observedAt: expect.any(String),
            }),
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "worker.waiting_user",
            data: expect.objectContaining({
              state: "waiting_user",
              source: fixture.statusSource,
              tier: 0,
              confidence: 1,
              observedAt: expect.any(String),
              questionSummary: expect.any(String),
            }),
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "worker.turn.settled",
            data: expect.objectContaining({
              state: "idle",
              source: fixture.statusSource,
              tier: 0,
              confidence: 1,
              observedAt: expect.any(String),
            }),
          }),
        );
      }
      if (fixture.nativeSessionId) {
        expect(result.outputs.nativeSessionId).toBe(fixture.nativeSessionId);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "worker.native_session.bound",
            data: expect.objectContaining({ nativeSessionId: fixture.nativeSessionId }),
          }),
        );
      }
    });

    it.each([
      { label: "in flight", preAborted: false },
      { label: "before start", preAborted: true },
    ])("settles promptly when cancelled $label", async ({ preAborted }) => {
      const fixture = createCancellation();
      const controller = new AbortController();
      const events: EmittedEvent[] = [];
      if (preAborted) controller.abort(new Error("pre-start contract cancellation"));
      const run = fixture.adapter.run(context(controller.signal, events));
      if (!preAborted) {
        await (fixture.started ?? Promise.resolve());
        controller.abort(new Error("contract cancellation"));
      }
      const outcome = await Promise.race([
        run.then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        ),
        new Promise<{ timeout: true }>((resolvePromise) =>
          setTimeout(() => resolvePromise({ timeout: true }), 1_000),
        ),
      ]);

      expect(outcome).not.toHaveProperty("timeout");
      if ("result" in outcome) expect(outcome.result.status).toBe("failed");
      else expect(outcome).toHaveProperty("error");
      if (!preAborted) {
        expect(fixture.cancellationForwarded?.() ?? true).toBe(true);
        if (fixture.nativeSessionId) {
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "worker.native_session.bound",
              data: expect.objectContaining({ nativeSessionId: fixture.nativeSessionId }),
            }),
          );
        }
      }
    });
  });
}

function context(signal: AbortSignal, events: EmittedEvent[]): WorkerRunContext {
  return {
    missionId: "mission-contract",
    workerRunId: "run-contract",
    workspacePath: "/tmp/worker-contract",
    profileHash: "profile-contract",
    attempt: 1,
    signal,
    emit: (event) => events.push(event),
    task: {
      id: "task-contract",
      title: "Exercise provider adapter",
      objective: "Prove the provider-neutral worker lifecycle.",
      kind: "implementation",
      role: "implementer",
      dependsOn: [],
      executionClass: "runner_headless",
      risk: "low",
      writeScope: ["src/**"],
      successCriteria: ["The lifecycle contract passes."],
      evidenceRequirements: ["Record provider evidence."],
      maxAttempts: 1,
      metadata: {},
    },
  };
}
