import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlRpcProcess, waitForMessage, type JsonlRpcTransport, type JsonObject } from "@clankie/jsonl-rpc";
import type { TaskKind, WorkerResult } from "@clankie/protocol";
import {
  cancelledWorkerResult,
  emitWorkerTurnSettled,
  emitWorkerTurnStarted,
  emitWorkerWaitingUser,
  type WorkerAdapter,
  type WorkerDescriptor,
  type WorkerRunContext,
} from "@clankie/worker-sdk";

export interface PiRpcOptions {
  command?: string;
  provider?: string;
  model?: string;
  sessionDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  rpcEntry?: boolean;
  extraArgs?: string[];
  processPreparer?: PiProcessPreparer;
  transportFactory?: (context: {
    cwd: string;
    args: string[];
    environment: NodeJS.ProcessEnv;
    run: WorkerRunContext;
  }) => JsonlRpcTransport | Promise<JsonlRpcTransport>;
}

export interface PiPreparedProcess {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  close?: () => Promise<void>;
}

export type PiProcessPreparer = (
  input: PiPreparedProcess & {
    cwd: string;
    run: WorkerRunContext;
  },
) => Promise<PiPreparedProcess>;

export const PI_CODING_AGENT_VERSION = "0.80.6";

export function resolveBundledPiRpcEntry(): string {
  return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
}

export interface PiClient {
  onMessage(listener: (message: JsonObject) => void): () => void;
  prompt(message: string, signal?: AbortSignal, timeoutMs?: number): Promise<PiPromptResult>;
  readiness(provider: string, model: string, sessionRoot: string, timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface PiPromptResult {
  text: string;
  state: JsonObject;
  stats: JsonObject;
}

export class PiRpcClient implements PiClient {
  private readonly rpc: JsonlRpcTransport;
  private readonly closePrepared: () => Promise<void>;

  private constructor(rpc: JsonlRpcTransport, closePrepared: () => Promise<void>) {
    this.rpc = rpc;
    this.closePrepared = closePrepared;
  }

  public static async create(
    cwd: string,
    run: WorkerRunContext,
    options: PiRpcOptions = {},
  ): Promise<PiRpcClient> {
    const args = options.rpcEntry ? [] : ["--mode", "rpc"];
    if (options.provider) args.push("--provider", options.provider);
    if (options.model) args.push("--model", options.model);
    if (options.sessionDirectory) args.push("--session-dir", options.sessionDirectory);
    else args.push("--no-session");
    args.push(
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--offline",
      ...(options.extraArgs ?? []),
    );
    const environment = options.environment ?? process.env;
    const prepared = options.processPreparer
      ? await options.processPreparer({
          command: options.command ?? "pi",
          args,
          environment,
          cwd,
          run,
        })
      : { command: options.command ?? "pi", args, environment };
    const rpc =
      (await options.transportFactory?.({
        cwd,
        args: prepared.args,
        environment: prepared.environment,
        run,
      })) ??
      new JsonlRpcProcess({
        command: prepared.command,
        args: prepared.args,
        cwd,
        env: prepared.environment,
        requestTimeoutMs: options.timeoutMs ?? 15 * 60_000,
      });
    return new PiRpcClient(rpc, prepared.close ?? (() => Promise.resolve()));
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

  public async readiness(
    provider: string,
    model: string,
    sessionRoot: string,
    timeoutMs = 5_000,
  ): Promise<boolean> {
    const state = await this.rpc.request({ type: "get_state" }, timeoutMs);
    const available = await this.rpc.request({ type: "get_available_models" }, timeoutMs);
    const models = readNestedValue(available, ["data", "models"]);
    const sessionId = readNestedString(state, ["data", "sessionId"]);
    const sessionFile = readNestedString(state, ["data", "sessionFile"]);
    if (!sessionId?.trim() || !sessionFile?.trim()) return false;
    return (
      (await sessionFileIsConfined(sessionFile, sessionRoot)) &&
      readNestedString(state, ["data", "model", "provider"]) === provider &&
      readNestedString(state, ["data", "model", "id"]) === model &&
      Array.isArray(models) &&
      models.some(
        (entry) =>
          readNestedString(entry, ["provider"]) === provider && readNestedString(entry, ["id"]) === model,
      )
    );
  }

  public close(): Promise<void> {
    return this.rpc.close().finally(() => this.closePrepared());
  }
}

export interface PiWorkerOptions extends PiRpcOptions {
  id?: string;
  displayName?: string;
  kinds?: TaskKind[];
  sessionRoot?: string;
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
    const sessionDirectory = this.options.sessionRoot
      ? join(
          this.options.sessionRoot,
          safeName(context.missionId),
          `${safeName(context.workerRunId)}-attempt-${context.attempt}`,
        )
      : this.options.sessionDirectory;
    if (sessionDirectory) await mkdir(sessionDirectory, { recursive: true });
    const client = await PiRpcClient.create(context.workspacePath, context, {
      ...this.options,
      ...(sessionDirectory ? { sessionDirectory } : {}),
    });
    const pendingTools = new Map<string, PendingPiTool>();
    const unsubscribe = client.onMessage((message) => {
      const providerType = typeof message.type === "string" ? message.type : "event";
      if (providerType === "turn_start") {
        emitWorkerTurnStarted(context, "pi.rpc");
      } else if (providerType === "agent_settled") {
        emitWorkerTurnSettled(context, "pi.rpc");
      } else if (isPiDialogRequest(message)) {
        emitWorkerWaitingUser(context, "pi.rpc", summarizePiDialogRequest(message));
      }
      const semanticEvent = completedPiToolEvent(message, pendingTools);
      if (semanticEvent) {
        context.emit({
          type: semanticEvent.type,
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: context.workerRunId,
          profileHash: context.profileHash,
          data: semanticEvent.data,
        });
      }
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
      const succeeded = !context.signal.aborted && Boolean(nativeSessionId);
      return {
        status: succeeded ? "succeeded" : "failed",
        summary: result.text.trim() || "Pi completed the task without a textual summary.",
        evidence: [{ kind: "log", label: "pi-rpc-session", summary: summarizeStats(result.stats) }],
        outputs: {
          workerRunId: context.workerRunId,
          nativeSessionId: nativeSessionId ?? null,
        },
        ...(!succeeded
          ? {
              diagnosis: context.signal.aborted
                ? "Pi run was aborted"
                : "Pi completed without a persistent native session ID",
            }
          : {}),
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
  const current = readNestedValue(value, path);
  return typeof current === "string" ? current : undefined;
}

function readNestedValue(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

async function sessionFileIsConfined(sessionFile: string, sessionRoot: string): Promise<boolean> {
  try {
    const canonicalRoot = await realpath(sessionRoot);
    const absoluteSessionFile = resolve(sessionFile);
    let canonicalSessionFile: string;
    try {
      canonicalSessionFile = await realpath(absoluteSessionFile);
      if (!(await stat(canonicalSessionFile)).isFile()) return false;
    } catch (error) {
      if (!isMissingPathError(error)) return false;
      try {
        await lstat(absoluteSessionFile);
        return false;
      } catch (entryError) {
        if (!isMissingPathError(entryError)) return false;
      }
      const canonicalParent = await realpath(dirname(absoluteSessionFile));
      canonicalSessionFile = join(canonicalParent, basename(absoluteSessionFile));
    }
    const relativePath = relative(canonicalRoot, canonicalSessionFile);
    return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
  } catch {
    return false;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

type PendingPiTool = { kind: "command" | "file"; fingerprint: string };
type CompletedPiToolEvent = {
  type: "worker.command.completed" | "worker.file_change.completed";
  data: Record<string, unknown>;
};

/** Correlates Pi's structured tool start/end events without retaining args or output. */
export function completedPiToolEvent(
  message: JsonObject,
  pending: Map<string, PendingPiTool>,
): CompletedPiToolEvent | undefined {
  const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
  const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
  if (!toolCallId || !toolName) return undefined;
  if (message.type === "tool_execution_start") {
    const args = asRecord(message.args);
    if (toolName === "bash") {
      pending.set(toolCallId, {
        kind: "command",
        fingerprint: fingerprint(typeof args.command === "string" ? args.command : ""),
      });
    } else if (toolName === "edit" || toolName === "write") {
      const path =
        typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
      pending.set(toolCallId, { kind: "file", fingerprint: fingerprint(path) });
    }
    return undefined;
  }
  if (message.type !== "tool_execution_end") return undefined;
  const tool = pending.get(toolCallId);
  if (!tool) return undefined;
  pending.delete(toolCallId);
  const result = message.isError === true ? "failed" : "passed";
  return tool.kind === "command"
    ? {
        type: "worker.command.completed",
        data: {
          provider: "pi",
          commandFingerprint: tool.fingerprint,
          exitCode: result === "passed" ? 0 : null,
          result,
        },
      }
    : {
        type: "worker.file_change.completed",
        data: {
          provider: "pi",
          changeCount: 1,
          pathFingerprints: [tool.fingerprint],
          result,
        },
      };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "") || "unnamed";
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
