import type { JsonlRpcTransport, JsonObject } from "@sapling/jsonl-rpc";
import { describe, expect, it } from "vitest";
import { runWorkerAdapterContract } from "../../worker-sdk/test/worker-contract.ts";
import { CodexWorkerAdapter, renderTaskPrompt } from "../src/index.ts";

describe("renderTaskPrompt", () => {
  it("makes scope and non-goals explicit", () => {
    const prompt = renderTaskPrompt({
      missionId: "m1",
      workerRunId: "run-codex-prompt",
      workspacePath: "/tmp/repo",
      profileHash: "p1",
      attempt: 1,
      signal: new AbortController().signal,
      emit: () => undefined,
      task: {
        id: "t1",
        title: "Implement parser",
        objective: "Add parser",
        kind: "implementation",
        role: "implementer",
        dependsOn: [],
        executionClass: "runner_visible",
        risk: "low",
        writeScope: ["src/parser.ts"],
        successCriteria: ["tests pass"],
        evidenceRequirements: ["Attach the diff and test result."],
        maxAttempts: 1,
        metadata: {},
      },
    });
    expect(prompt).toContain("src/parser.ts");
    expect(prompt).toContain("Role: implementer");
    expect(prompt).toContain("Attach the diff and test result.");
    expect(prompt).toContain("Do not merge");
  });
});

runWorkerAdapterContract(
  "Codex App Server",
  () => {
    const transport = new RecordedCodexTransport("success");
    return {
      adapter: new CodexWorkerAdapter({ transportFactory: () => transport }),
      assigned: () => transport.assigned,
      nativeSessionId: "codex-thread",
    };
  },
  () => {
    const transport = new RecordedCodexTransport("cancellation");
    return {
      adapter: new CodexWorkerAdapter({ transportFactory: () => transport }),
      nativeSessionId: "codex-thread",
      started: transport.started,
      cancellationForwarded: () => transport.interrupted,
    };
  },
);

class RecordedCodexTransport implements JsonlRpcTransport {
  public assigned = false;
  public interrupted = false;
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
    if (message.method === "initialize") return { result: {} };
    if (message.method === "thread/start") return { result: { thread: { id: "codex-thread" } } };
    if (message.method === "turn/start") {
      const params = message.params as Record<string, unknown>;
      this.assigned =
        params.cwd === "/tmp/worker-contract" && JSON.stringify(params.input).includes("task-contract");
      this.startRun?.();
      if (this.mode === "success") this.complete("completed");
      return { result: { turn: { id: "codex-turn" } } };
    }
    if (message.method === "turn/interrupt") {
      this.interrupted = true;
      this.complete("interrupted");
      return { result: {} };
    }
    throw new Error(`Unexpected Codex request ${String(message.method)}`);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  private complete(status: string): void {
    this.emit({ method: "item/agentMessage/delta", params: { delta: "Codex contract complete." } });
    this.emit({
      method: "turn/completed",
      params: { threadId: "codex-thread", turn: { id: "codex-turn", status } },
    });
  }

  private emit(message: JsonObject): void {
    for (const listener of this.listeners) listener(message);
  }
}
