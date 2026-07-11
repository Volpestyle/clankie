import type { JsonlRpcTransport, JsonObject } from "@sapling/jsonl-rpc";
import { describe, expect, it } from "vitest";
import { runWorkerAdapterContract } from "../../worker-sdk/test/worker-contract.ts";
import { PiWorkerAdapter, renderPiPrompt } from "../src/index.ts";

describe("renderPiPrompt", () => {
  it("protects tests and external authority", () => {
    const prompt = renderPiPrompt({
      missionId: "m",
      workerRunId: "run-pi-prompt",
      workspacePath: "/tmp",
      profileHash: "p",
      attempt: 1,
      signal: new AbortController().signal,
      emit: () => undefined,
      task: {
        id: "t",
        title: "Debug",
        objective: "Fix failure",
        kind: "debugging",
        role: "debugger",
        dependsOn: [],
        executionClass: "runner_visible",
        risk: "low",
        writeScope: ["src/**"],
        successCriteria: ["test passes"],
        evidenceRequirements: ["Record the unchanged test command and exit code."],
        maxAttempts: 1,
        metadata: {},
      },
    });
    expect(prompt).toContain("Do not modify tests");
    expect(prompt).toContain("Role: debugger");
    expect(prompt).toContain("Record the unchanged test command and exit code.");
    expect(prompt).toContain("Do not merge");
  });
});

runWorkerAdapterContract(
  "Pi RPC",
  () => {
    let spawnedCorrectly = false;
    const transport = new RecordedPiTransport("success");
    return {
      adapter: new PiWorkerAdapter({
        transportFactory: ({ cwd, args }) => {
          spawnedCorrectly = cwd === "/tmp/worker-contract" && args.includes("rpc");
          return transport;
        },
      }),
      assigned: () => spawnedCorrectly && transport.assigned,
      nativeSessionId: "pi-session",
      statusSource: "pi.rpc",
    };
  },
  () => {
    const transport = new RecordedPiTransport("cancellation");
    return {
      adapter: new PiWorkerAdapter({ transportFactory: () => transport }),
      nativeSessionId: "pi-session",
      started: transport.started,
      cancellationForwarded: () => transport.aborted,
    };
  },
);

class RecordedPiTransport implements JsonlRpcTransport {
  public aborted = false;
  public assigned = false;
  public readonly started: Promise<void>;
  private readonly listeners = new Set<(message: JsonObject) => void>();
  private readonly mode: "success" | "cancellation";
  private startRun: (() => void) | undefined;

  public constructor(mode: "success" | "cancellation") {
    this.mode = mode;
    this.started = new Promise((resolvePromise) => {
      this.startRun = resolvePromise;
    });
  }

  public onMessage(listener: (message: JsonObject) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public notify(): void {}

  public async request(message: JsonObject): Promise<JsonObject> {
    if (message.type === "prompt") {
      this.assigned = typeof message.message === "string" && message.message.includes("task-contract");
      this.startRun?.();
      this.emit({ type: "turn_start" });
      if (this.mode === "success") {
        this.emit({
          type: "extension_ui_request",
          id: "pi-question-1",
          method: "confirm",
          title: "Continue the Pi contract run?",
        });
        this.emit({ type: "agent_settled" });
      }
      return { data: {} };
    }
    if (message.type === "abort") {
      this.aborted = true;
      this.emit({ type: "agent_settled" });
      return { data: {} };
    }
    if (message.type === "get_last_assistant_text") {
      return { data: { text: "Pi contract complete." } };
    }
    if (message.type === "get_state") return { data: { mode: "idle" } };
    if (message.type === "get_session_stats") {
      return { data: { sessionId: "pi-session", toolCalls: 0, cost: 0 } };
    }
    throw new Error(`Unexpected Pi request ${String(message.type)}`);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  private emit(message: JsonObject): void {
    for (const listener of this.listeners) listener(message);
  }
}
