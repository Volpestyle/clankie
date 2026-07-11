import { JsonlRpcProcess, waitForMessage, type JsonObject } from "@sapling/jsonl-rpc";
import type { TaskKind, WorkerResult } from "@sapling/protocol";
import type { WorkerAdapter, WorkerDescriptor, WorkerRunContext } from "@sapling/worker-sdk";

export interface CodexAppServerOptions {
  command?: string;
  model?: string;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  environment?: NodeJS.ProcessEnv;
  turnTimeoutMs?: number;
}

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  status: string;
  text: string;
  notifications: JsonObject[];
}

export class CodexAppServerClient {
  private readonly rpc: JsonlRpcProcess;
  private initialized = false;

  public constructor(private readonly options: CodexAppServerOptions = {}) {
    this.rpc = new JsonlRpcProcess({
      command: options.command ?? "codex",
      args: ["app-server", "--listen", "stdio://"],
      env: options.environment ?? process.env,
      requestTimeoutMs: options.turnTimeoutMs ?? 15 * 60_000,
    });
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc.request({
      method: "initialize",
      params: {
        clientInfo: {
          name: this.options.clientName ?? "sapling_agent_os",
          title: this.options.clientTitle ?? "Sapling Agent OS",
          version: this.options.clientVersion ?? "0.1.0",
        },
      },
    });
    this.rpc.notify({ method: "initialized", params: {} });
    this.initialized = true;
  }

  public async runTurn(input: {
    cwd: string;
    prompt: string;
    model?: string;
    writeEnabled: boolean;
    signal?: AbortSignal;
    onNotification?: (message: JsonObject) => void;
  }): Promise<CodexTurnResult> {
    await this.initialize();
    const notifications: JsonObject[] = [];
    let text = "";
    const unsubscribe = this.rpc.onMessage((message) => {
      if (typeof message.method !== "string") return;
      notifications.push(message);
      input.onNotification?.(message);
      if (message.method === "item/agentMessage/delta") {
        const params = asRecord(message.params);
        const delta = typeof params.delta === "string" ? params.delta : "";
        text += delta;
      }
    });

    try {
      const started = await this.rpc.request({
        method: "thread/start",
        params: {
          model: input.model ?? this.options.model,
          cwd: input.cwd,
          approvalPolicy: "never",
          sandbox: input.writeEnabled ? "workspaceWrite" : "readOnly",
          serviceName: "sapling-agent-os",
        },
      });
      const threadId = readNestedString(started, ["result", "thread", "id"]);
      const turnResponse = await this.rpc.request({
        method: "turn/start",
        params: {
          threadId,
          cwd: input.cwd,
          approvalPolicy: "never",
          sandboxPolicy: input.writeEnabled
            ? { type: "workspaceWrite", writableRoots: [input.cwd], networkAccess: false }
            : { type: "readOnly", networkAccess: false },
          input: [{ type: "text", text: input.prompt }],
        },
      });
      const turnId = readNestedString(turnResponse, ["result", "turn", "id"]);
      const abort = () => {
        void this.rpc
          .request({ method: "turn/interrupt", params: { threadId, turnId } }, 10_000)
          .catch(() => undefined);
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      const completed = await waitForMessage(
        this.rpc,
        (message) =>
          message.method === "turn/completed" &&
          readNestedStringOrUndefined(message, ["params", "threadId"]) === threadId &&
          readNestedStringOrUndefined(message, ["params", "turn", "id"]) === turnId,
        this.options.turnTimeoutMs ?? 15 * 60_000,
      );
      input.signal?.removeEventListener("abort", abort);
      const status = readNestedStringOrUndefined(completed, ["params", "turn", "status"]) ?? "completed";
      return { threadId, turnId, status, text, notifications };
    } finally {
      unsubscribe();
    }
  }

  public close(): Promise<void> {
    return this.rpc.close();
  }
}

export interface CodexWorkerOptions extends CodexAppServerOptions {
  id?: string;
  displayName?: string;
  kinds?: TaskKind[];
}

export class CodexWorkerAdapter implements WorkerAdapter {
  public readonly descriptor: WorkerDescriptor;

  public constructor(private readonly options: CodexWorkerOptions = {}) {
    this.descriptor = {
      id: options.id ?? "codex-app-server",
      displayName: options.displayName ?? "Codex",
      harness: "codex" as const,
      ...(options.model ? { model: options.model } : {}),
      capabilities: {
        kinds: options.kinds ?? ["implementation", "debugging", "verification", "review", "integration"],
        canWrite: true,
        supportsStructuredEvents: true,
        supportsTerminal: true,
        supportsNativeSession: true,
      },
    };
  }

  public async run(context: WorkerRunContext): Promise<WorkerResult> {
    const client = new CodexAppServerClient(this.options);
    const writeEnabled = ["implementation", "debugging", "integration", "design"].includes(context.task.kind);
    try {
      const result = await client.runTurn({
        cwd: context.workspacePath,
        prompt: renderTaskPrompt(context),
        writeEnabled,
        signal: context.signal,
        onNotification: (notification) => {
          const method = typeof notification.method === "string" ? notification.method : "codex.notification";
          context.emit({
            type: `provider.codex.${method.replaceAll("/", ".")}`,
            missionId: context.missionId,
            taskId: context.task.id,
            profileHash: context.profileHash,
            data: { method, params: notification.params ?? null },
          });
        },
      });
      const succeeded = ["completed", "succeeded"].includes(result.status);
      return {
        status: succeeded ? "succeeded" : "failed",
        summary: result.text.trim() || `Codex turn ended with status ${result.status}.`,
        evidence: [
          {
            kind: "log",
            label: "codex-app-server-turn",
            summary: `thread=${result.threadId} turn=${result.turnId} status=${result.status}`,
          },
        ],
        outputs: {
          nativeSessionId: result.threadId,
          nativeTurnId: result.turnId,
          notificationCount: result.notifications.length,
        },
        ...(succeeded ? {} : { diagnosis: `Codex turn status was ${result.status}` }),
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

export function renderTaskPrompt(context: WorkerRunContext): string {
  return [
    "You are a worker in a governed multi-agent mission.",
    `Mission: ${context.missionId}`,
    `Task: ${context.task.title}`,
    `Objective: ${context.task.objective}`,
    `Success criteria:\n${context.task.successCriteria.map((item) => `- ${item}`).join("\n")}`,
    `Allowed write scope:\n${context.task.writeScope.length ? context.task.writeScope.map((item) => `- ${item}`).join("\n") : "- none; do not modify files"}`,
    "Work only on this task. Run relevant checks. Do not merge, deploy, change tracker state, or weaken tests.",
    "Finish with a concise summary, files changed, commands run, results, and remaining risks.",
  ].join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNestedString(value: unknown, path: string[]): string {
  const result = readNestedStringOrUndefined(value, path);
  if (!result) throw new Error(`Expected string at ${path.join(".")}`);
  return result;
}

function readNestedStringOrUndefined(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) current = asRecord(current)[segment];
  return typeof current === "string" ? current : undefined;
}
