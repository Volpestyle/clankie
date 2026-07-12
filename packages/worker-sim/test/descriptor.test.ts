import type { DomainEvent } from "@clankie/protocol";
import type { WorkerRunContext } from "@clankie/worker-sdk";
import { describe, expect, it } from "vitest";
import { SimulatedWorkerAdapter } from "../src/index.ts";

type EmittedEvent = Omit<DomainEvent, "id" | "occurredAt" | "correlationId">;

// Reconciles VUH-820: the descriptor flag and the adapter's runtime behavior
// must agree. `supportsNativeSession` means "has a provider-native session"
// (Codex/Claude/Pi bind one; sim does not). A runner sim handler may bind a
// synthetic `sim:<workerRunId>` id for correlation, but that is runner-owned
// and does not make the simulated worker itself provider-native.
describe("SimulatedWorkerAdapter native-session contract", () => {
  it("advertises no provider-native session support", () => {
    const adapter = new SimulatedWorkerAdapter({ id: "sim-native", kinds: ["implementation"], handlers: {} });
    expect(adapter.descriptor.capabilities.supportsNativeSession).toBe(false);
  });

  it("binds no provider-native session at runtime, matching the flag", async () => {
    const events: EmittedEvent[] = [];
    const adapter = new SimulatedWorkerAdapter({
      id: "sim-native",
      kinds: ["implementation"],
      handlers: {
        implementation: () => ({
          status: "succeeded",
          summary: "ok",
          evidence: [{ kind: "log", label: "sim", summary: "ran" }],
          outputs: {},
        }),
      },
    });

    const result = await adapter.run(context(events));

    // The adapter itself neither emits a native-session binding nor reports a
    // provider-native session id — behavior agrees with supportsNativeSession=false.
    expect(events.some((event) => event.type === "worker.native_session.bound")).toBe(false);
    expect(result.outputs.nativeSessionId ?? null).toBeNull();
  });
});

function context(events: EmittedEvent[]): WorkerRunContext {
  return {
    missionId: "mission-native",
    workerRunId: "run-native",
    workspacePath: "/tmp/worker-native",
    profileHash: "profile-native",
    attempt: 1,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    task: {
      id: "task-native",
      title: "Exercise the simulated worker",
      objective: "Prove the simulated worker binds no provider-native session.",
      kind: "implementation",
      role: "implementer",
      dependsOn: [],
      executionClass: "runner_headless",
      risk: "low",
      writeScope: ["src/**"],
      successCriteria: ["The native-session contract holds."],
      evidenceRequirements: ["Record simulated evidence."],
      maxAttempts: 1,
      metadata: {},
    },
  };
}
