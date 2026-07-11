import { JsonlRpcProcess, waitForMessage, type JsonlRpcTransport, type JsonObject } from "@sapling/jsonl-rpc";
import type { TaskKind, WorkerResult } from "@sapling/protocol";
import {
  cancelledWorkerResult,
  emitWorkerTurnSettled,
  emitWorkerTurnStarted,
  emitWorkerWaitingUser,
  type WorkerAdapter,
  type WorkerDescriptor,
  type WorkerRunContext,
} from "@sapling/worker-sdk";

export interface PiRpcOptions {
  command?: string;
  provider?: string;
  model?: string;
  sessionDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  transportFactory?: (context: { cwd: string; args: string[] }) => JsonlRpcTransport;
}

export interface PiClient {
  onMessage(listener: (message: JsonObject) => void): () => void;
  prompt(message: string, signal?: AbortSignal, timeoutMs?: number): Promise<PiPromptResult>;
  close(): Promise<void>;
}

export interface PiPromptResult {
  text: string;
  state: JsonObject;
  stats: JsonObject;
}

export class PiRpcClient implements PiClient {
  private readonly rpc: JsonlRpcTransport;

  public constructor(cwd: string, options: PiRpcOptions = {}) {
    const args = ["--mode", "rpc"];
    if (options.provider) args.push("--provider", options.provider);
    if (options.model) args.push("--model", options.model);
    if (options.sessionDirectory) args.push("--session-dir", options.sessionDirectory);
    else args.push("--no-session");
    this.rpc =
      options.transportFactory?.({ cwd, args }) ??
      new JsonlRpcProcess({
        command: options.command ?? "pi",
        args,
        cwd,
        env: options.environment ?? process.env,
        requestTimeoutMs: options.timeoutMs ?? 15 * 60_000,
      });
  }

  public onMessage(listener: (message: JsonObject) => void): () => void {
    return this.rpc.onMessage(listener);
  }

  public async prompt(
    message: string,
    signal?: AbortSignal,
    timeoutMs = 15 * 60_000,
  ): Promise<PiPromptResult> {
    const terminalWait = new AbortController();
    const settled = waitForMessage(
      this.rpc,
      (event) => event.type === "agent_settled",
      timeoutMs,
      terminalWait.signal,
    );
    try {
      await this.rpc.request({ type: "prompt", message });
    } catch (error) {
      terminalWait.abort(error);
      await settled.catch(() => undefined);
      throw error;
    }
    const abort = () => {
      void this.rpc.request({ type: "abort" }, 10_000).catch(() => undefined);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      await settled;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    const textResponse = await this.rpc.request({ type: "get_last_assistant_text" });
    const state = await this.rpc.request({ type: "get_state" });
    const stats = await this.rpc.request({ type: "get_session_stats" });
    return {
      text: readNestedString(textResponse, ["data", "text"]) ?? "",
      state,
      stats,
    };
  }

  public close(): Promise<void> {
    return this.rpc.close();
  }
}

export interface PiWorkerOptions extends PiRpcOptions {
  id?: string;
  displayName?: string;
  kinds?: TaskKind[];
}

export class PiWorkerAdapter implements WorkerAdapter {
  public readonly descriptor: WorkerDescriptor;
  private readonly options: PiWorkerOptions;

  public constructor(options: PiWorkerOptions = {}) {
    this.options = options;
    this.descriptor = {
      id: options.id ?? "pi-rpc",
      displayName: options.displayName ?? "Pi",
      harness: "pi" as const,
      ...(options.model ? { model: options.model } : {}),
      capabilities: {
        kinds: options.kinds ?? ["research", "implementation", "debugging", "verification", "review"],
        canWrite: true,
        supportsStructuredEvents: true,
        supportsTerminal: true,
        supportsNativeSession: true,
      },
    };
  }

  public async run(context: WorkerRunContext): Promise<WorkerResult> {
    if (context.signal.aborted) return cancelledWorkerResult(context.workerRunId, "Pi");
    const client = new PiRpcClient(context.workspacePath, this.options);
    const unsubscribe = client.onMessage((message) => {
      const providerType = typeof message.type === "string" ? message.type : "event";
      if (providerType === "turn_start") {
        emitWorkerTurnStarted(context, "pi.rpc");
      } else if (providerType === "agent_settled") {
        emitWorkerTurnSettled(context, "pi.rpc");
      } else if (isPiDialogRequest(message)) {
        emitWorkerWaitingUser(context, "pi.rpc", summarizePiDialogRequest(message));
      }
      context.emit({
        type: `provider.pi.${providerType}`,
        missionId: context.missionId,
        taskId: context.task.id,
        workerRunId: context.workerRunId,
        profileHash: context.profileHash,
        data: sanitizePiEvent(message),
      });
    });
    try {
      const result = await client.prompt(renderPiPrompt(context), context.signal, this.options.timeoutMs);
      const nativeSessionId = readNestedString(result.stats, ["data", "sessionId"]);
      if (nativeSessionId) {
        context.emit({
          type: "worker.native_session.bound",
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: context.workerRunId,
          profileHash: context.profileHash,
          data: { provider: "pi", nativeSessionId },
        });
      }
      return {
        status: context.signal.aborted ? "failed" : "succeeded",
        summary: result.text.trim() || "Pi completed the task without a textual summary.",
        evidence: [{ kind: "log", label: "pi-rpc-session", summary: summarizeStats(result.stats) }],
        outputs: {
          workerRunId: context.workerRunId,
          nativeSessionId: nativeSessionId ?? null,
          state: result.state.data ?? null,
          stats: result.stats.data ?? null,
        },
        ...(context.signal.aborted ? { diagnosis: "Pi run was aborted" } : {}),
      };
    } finally {
      unsubscribe();
      await client.close().catch(() => undefined);
    }
  }
}

export function renderPiPrompt(context: WorkerRunContext): string {
  return [
    `Mission ${context.missionId}; task ${context.task.id}: ${context.task.title}`,
    `Role: ${context.task.role}`,
    context.task.objective,
    `Success criteria:\n${context.task.successCriteria.map((value) => `- ${value}`).join("\n")}`,
    `Required evidence:\n${context.task.evidenceRequirements.map((value) => `- ${value}`).join("\n")}`,
    `Write scope:\n${context.task.writeScope.length ? context.task.writeScope.map((value) => `- ${value}`).join("\n") : "- read-only"}`,
    "Do not modify tests merely to make them pass. Do not merge, deploy, or update external systems.",
    "Return evidence: files changed, commands run, exact results, and remaining uncertainty.",
  ].join("\n\n");
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? current : undefined;
}

function sanitizePiEvent(message: JsonObject): Record<string, unknown> {
  if (message.type === "message_update") {
    const update = message.assistantMessageEvent;
    if (update && typeof update === "object" && !Array.isArray(update)) {
      const record = update as Record<string, unknown>;
      return { type: message.type, deltaType: record.type, delta: record.delta };
    }
  }
  if (message.type === "tool_execution_start" || message.type === "tool_execution_end") {
    return {
      type: message.type,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    };
  }
  return { type: message.type ?? "event" };
}

const PI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function isPiDialogRequest(message: JsonObject): boolean {
  return message.type === "extension_ui_request" && PI_DIALOG_METHODS.has(String(message.method));
}

function summarizePiDialogRequest(message: JsonObject): string {
  for (const key of ["title", "message", "placeholder"] as const) {
    const summary = message[key];
    if (typeof summary === "string" && summary.trim()) return summary;
  }
  return `Pi requires ${String(message.method ?? "user input")}`;
}

function summarizeStats(response: JsonObject): string {
  const data = response.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Pi session completed.";
  const record = data as Record<string, unknown>;
  return `session=${String(record.sessionId ?? "unknown")} tools=${String(record.toolCalls ?? "unknown")} cost=${String(record.cost ?? "unknown")}`;
}
