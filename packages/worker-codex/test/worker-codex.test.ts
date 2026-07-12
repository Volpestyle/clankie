import type { JsonlRpcTransport, JsonObject } from "@clankie/jsonl-rpc";
import { describe, expect, it } from "vitest";
import { runWorkerAdapterContract } from "../../worker-sdk/test/worker-contract.ts";
import {
  CodexAppServerClient,
  CodexWorkerAdapter,
  codexAppServerArguments,
  completedCodexItem,
  renderTaskPrompt,
} from "../src/index.ts";

describe("Codex tool boundary", () => {
  it("injects strict named profiles, exact deny-read paths, and a synthetic shell environment", () => {
    const args = codexAppServerArguments({
      deniedReadPaths: ["/runner/auth.json", "/host/.ssh"],
      toolEnvironment: { HOME: "/runner/tool-home", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    });
    expect(args).toContain("--strict-config");
    expect(args).toContain("shell_snapshot");
    const serialized = args.join("\n");
    expect(serialized).toContain("permissions.clankie_native_write={ filesystem = {");
    expect(serialized).toContain("network = { enabled = false }");
    expect(serialized).toContain('"/runner/auth.json" = "deny"');
    expect(serialized).toContain('"/host/.ssh" = "deny"');
    expect(serialized).toContain('":minimal" = "read"');
    expect(serialized).toContain('":workspace_roots" = { "." = "write" }');
    expect(args).toContain('shell_environment_policy.inherit="none"');
    expect(args).toContain('shell_environment_policy.set.HOME="/runner/tool-home"');
    expect(serialized).not.toContain("CODEX_HOME");
    expect(serialized).not.toContain('"/host/arbitrary-private" = "read"');
  });

  it("fails closed when deny-read paths or the synthetic HOME/PATH are absent", () => {
    expect(() => codexAppServerArguments({ toolEnvironment: { HOME: "/tool", PATH: "/bin" } })).toThrow(
      "codex_tool_boundary_denied_paths_required",
    );
    expect(() => codexAppServerArguments({ deniedReadPaths: ["/runner/auth.json"] })).toThrow(
      "codex_tool_boundary_environment_required",
    );
  });
});

describe("completedCodexItem", () => {
  it("normalizes authoritative completed command and file items without raw provider content", () => {
    const command = completedCodexItem({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          command: "printf SUPER_SECRET",
          aggregatedOutput: "SUPER_SECRET",
          exitCode: 0,
          status: "completed",
        },
      },
    });
    expect(command).toMatchObject({
      type: "worker.command.completed",
      data: { provider: "codex", exitCode: 0, result: "passed" },
    });
    expect(JSON.stringify(command)).not.toContain("SUPER_SECRET");

    const file = completedCodexItem({
      method: "item/completed",
      params: {
        item: {
          type: "fileChange",
          status: "completed",
          changes: [{ path: "src/secret.ts", diff: "SUPER_SECRET" }],
        },
      },
    });
    expect(file).toMatchObject({
      type: "worker.file_change.completed",
      data: { provider: "codex", changeCount: 1, result: "passed" },
    });
    expect(JSON.stringify(file)).not.toContain("src/secret.ts");
    expect(JSON.stringify(file)).not.toContain("SUPER_SECRET");
  });
});

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

it("maps typed steering to turn/steer and preserves command idempotency identity", async () => {
  const transport = new RecordedCodexTransport("steering");
  const client = new CodexAppServerClient({ transportFactory: () => transport });
  const run = client.runTurn({
    cwd: "/tmp/worker-contract",
    prompt: "steer test",
    writeEnabled: true,
  });
  await transport.started;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  const command = {
    schemaVersion: 1 as const,
    commandId: "steer-command-1",
    workerRunId: "run-steer",
    attempt: 1,
    sourceLane: "api" as const,
    intent: { type: "focus" as const, target: "failing_test" as const },
    principal: { kind: "captain" as const, id: "captain-1" },
    correlationId: "correlation-1",
    missionId: "mission-steer",
    taskId: "task-steer",
    profileHash: "profile-steer",
    input: "Focus on the failing test.",
  };
  await client.steer(command);
  await client.steer(command);
  await run;
  expect(transport.steerRequests).toEqual(["steer-command-1"]);
});

runWorkerAdapterContract(
  "Codex App Server",
  () => {
    const transport = new RecordedCodexTransport("success");
    return {
      adapter: new CodexWorkerAdapter({ transportFactory: () => transport }),
      assigned: () => transport.assigned,
      nativeSessionId: "codex-thread",
      statusSource: "codex.app_server",
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
  public readonly steerRequests: string[] = [];
  public secureProfileSelected = false;
  public readonly started: Promise<void>;
  private readonly listeners = new Set<(message: JsonObject) => void>();
  private readonly mode: "success" | "cancellation" | "steering";
  private startRun: (() => void) | undefined;

  public constructor(mode: "success" | "cancellation" | "steering") {
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
    if (message.method === "thread/start") {
      const params = message.params as Record<string, unknown>;
      this.secureProfileSelected =
        params.permissions === "clankie_native_write" &&
        !("sandbox" in params) &&
        !("sandboxPolicy" in params);
      return { result: { thread: { id: "codex-thread" } } };
    }
    if (message.method === "turn/start") {
      const params = message.params as Record<string, unknown>;
      this.assigned =
        params.cwd === "/tmp/worker-contract" &&
        params.clientUserMessageId === "run-contract:1" &&
        params.permissions === "clankie_native_write" &&
        !("sandboxPolicy" in params) &&
        this.secureProfileSelected &&
        JSON.stringify(params.input).includes("task-contract");
      this.startRun?.();
      this.emit({
        method: "turn/started",
        params: { threadId: "codex-thread", turn: { id: "codex-turn", status: "inProgress" } },
      });
      if (this.mode === "success") this.complete("completed");
      return { result: { turn: { id: "codex-turn" } } };
    }
    if (message.method === "turn/interrupt") {
      this.interrupted = true;
      this.complete("interrupted");
      return { result: {} };
    }
    if (message.method === "turn/steer") {
      const params = message.params as Record<string, unknown>;
      this.steerRequests.push(String(params.clientUserMessageId));
      this.complete("completed");
      return { result: { turnId: "codex-turn" } };
    }
    throw new Error(`Unexpected Codex request ${String(message.method)}`);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  private complete(status: string): void {
    if (this.mode === "success") {
      this.emit({
        id: "request-user-input-1",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "codex-thread",
          turnId: "codex-turn",
          itemId: "item-1",
          questions: [{ id: "confirm", question: "Continue with the scoped change?" }],
        },
      });
      this.emit({
        method: "item/completed",
        params: {
          threadId: "codex-thread",
          turnId: "codex-turn",
          item: {
            type: "commandExecution",
            command: "pnpm test",
            status: "completed",
            exitCode: 0,
          },
        },
      });
    }
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
