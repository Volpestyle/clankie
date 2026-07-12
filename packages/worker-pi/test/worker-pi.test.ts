import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonlRpcTransport, JsonObject } from "@clankie/jsonl-rpc";
import { describe, expect, it } from "vitest";
import { runWorkerAdapterContract } from "../../worker-sdk/test/worker-contract.ts";
import { PiRpcClient, PiWorkerAdapter, completedPiToolEvent, renderPiPrompt } from "../src/index.ts";

describe("completedPiToolEvent", () => {
  it("emits completed semantic facts without raw tool args or output", () => {
    const pending = new Map();
    expect(
      completedPiToolEvent(
        {
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "printf SECRET" },
        },
        pending,
      ),
    ).toBeUndefined();
    const completed = completedPiToolEvent(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "SECRET" }] },
        isError: false,
      },
      pending,
    );
    expect(completed).toMatchObject({
      type: "worker.command.completed",
      data: { provider: "pi", exitCode: 0, result: "passed" },
    });
    expect(JSON.stringify(completed)).not.toContain("SECRET");
  });
});

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

describe("Pi process boundary", () => {
  it("awaits a runner process preparer and uses a persistent session directory", async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), "clankie-pi-sessions-"));
    const transport = new RecordedPiTransport("success");
    let prepared = false;
    const adapter = new PiWorkerAdapter({
      sessionRoot,
      processPreparer: async (input) => {
        prepared = input.args.includes("--session-dir") && input.args.includes("--no-extensions");
        return { command: "/sandbox/exec", args: ["--", input.command, ...input.args], environment: {} };
      },
      transportFactory: ({ args }) => {
        expect(args[0]).toBe("--");
        return transport;
      },
    });
    const result = await adapter.run(piContext());
    expect(prepared).toBe(true);
    expect(result.status).toBe("succeeded");
    expect(result.outputs.nativeSessionId).toBe("pi-session");
  });

  it("fails a nominal run that does not bind a native session ID", async () => {
    const adapter = new PiWorkerAdapter({
      transportFactory: () => new RecordedPiTransport("missing-session"),
    });
    await expect(adapter.run(piContext())).resolves.toMatchObject({
      status: "failed",
      diagnosis: "Pi completed without a persistent native session ID",
    });
  });
});

describe("Pi readiness session confinement", () => {
  it("accepts a prospective session file only when the directory entry is truly absent", async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), "clankie-pi-prospective-session-"));
    const sessionFile = join(sessionRoot, "session.jsonl");
    const client = await readinessClient(sessionFile);
    try {
      await expect(client.readiness("ollama", "local-coder:latest", sessionRoot)).resolves.toBe(true);
    } finally {
      await client.close();
    }
  });

  it("rejects a dangling final-component session symlink", async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), "clankie-pi-dangling-session-"));
    const outside = await mkdtemp(join(tmpdir(), "clankie-pi-dangling-outside-"));
    const sessionFile = join(sessionRoot, "session.jsonl");
    await symlink(join(outside, "missing.jsonl"), sessionFile);
    const client = await readinessClient(sessionFile);
    try {
      await expect(client.readiness("ollama", "local-coder:latest", sessionRoot)).resolves.toBe(false);
    } finally {
      await client.close();
    }
  });
});

class RecordedPiTransport implements JsonlRpcTransport {
  public aborted = false;
  public assigned = false;
  public readonly started: Promise<void>;
  private readonly listeners = new Set<(message: JsonObject) => void>();
  private readonly mode: "success" | "cancellation" | "missing-session";
  private startRun: (() => void) | undefined;

  public constructor(mode: "success" | "cancellation" | "missing-session") {
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
        this.emit({
          type: "tool_execution_start",
          toolCallId: "bash-1",
          toolName: "bash",
          args: { command: "pnpm test" },
        });
        this.emit({
          type: "tool_execution_end",
          toolCallId: "bash-1",
          toolName: "bash",
          result: { content: [] },
          isError: false,
        });
        this.emit({ type: "agent_settled" });
      } else if (this.mode === "missing-session") {
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
      return {
        data: {
          sessionId: this.mode === "missing-session" ? null : "pi-session",
          toolCalls: 0,
          cost: 0,
        },
      };
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

class ReadinessPiTransport implements JsonlRpcTransport {
  private readonly sessionFile: string;

  public constructor(sessionFile: string) {
    this.sessionFile = sessionFile;
  }

  public onMessage(): () => void {
    return () => undefined;
  }

  public notify(): void {}

  public request(message: JsonObject): Promise<JsonObject> {
    if (message.type === "get_state") {
      return Promise.resolve({
        data: {
          model: { provider: "ollama", id: "local-coder:latest" },
          sessionId: "readiness-session",
          sessionFile: this.sessionFile,
        },
      });
    }
    if (message.type === "get_available_models") {
      return Promise.resolve({
        data: { models: [{ provider: "ollama", id: "local-coder:latest" }] },
      });
    }
    throw new Error(`Unexpected readiness request ${String(message.type)}`);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

function readinessClient(sessionFile: string): Promise<PiRpcClient> {
  return PiRpcClient.create("/tmp/worker-contract", piContext(), {
    transportFactory: () => new ReadinessPiTransport(sessionFile),
  });
}

function piContext() {
  return {
    missionId: "mission-pi",
    workerRunId: "run-pi",
    workspacePath: "/tmp/worker-contract",
    profileHash: "profile-pi",
    attempt: 1,
    signal: new AbortController().signal,
    emit: () => undefined,
    task: {
      id: "debug",
      title: "Debug",
      objective: "Fix the failure",
      kind: "debugging" as const,
      role: "debugger" as const,
      dependsOn: [],
      executionClass: "runner_headless" as const,
      risk: "low" as const,
      writeScope: ["src/**"],
      successCriteria: ["fixed"],
      evidenceRequirements: ["runner evidence"],
      maxAttempts: 1,
      metadata: {},
    },
  };
}
