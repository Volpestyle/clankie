import { createHash } from "node:crypto";
import { delimiter, isAbsolute } from "node:path";
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
  type WorkerSteerCommand,
} from "@clankie/worker-sdk";

/**
 * One stdio MCP server pre-approved by the runner's doctrine projection.
 * Codex cannot filter individual MCP tools, so the runner only projects
 * servers whose every declared tool doctrine allows. The server process is a
 * connector adapter started by Codex itself; `env` is the resolved credential
 * allowlist, never the provider parent environment.
 */
export interface CodexMcpServer {
  name: string;
  /** Task kinds allowed to see this server. Omitted means every kind. */
  kinds?: TaskKind[];
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CodexAppServerOptions {
  command?: string;
  model?: string;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  environment?: NodeJS.ProcessEnv;
  /** Environment exposed to model-invoked shell tools, never the provider parent environment. */
  toolEnvironment?: NodeJS.ProcessEnv;
  /** Absolute host-private paths denied to every model-invoked tool. */
  deniedReadPaths?: string[];
  /** Doctrine-projected MCP servers supplied by the runner. */
  mcpServers?: CodexMcpServer[];
  turnTimeoutMs?: number;
  transportFactory?: () => JsonlRpcTransport;
}

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  status: string;
  text: string;
  notifications: JsonObject[];
}

export interface CodexTurnInput {
  cwd: string;
  prompt: string;
  model?: string;
  writeEnabled: boolean;
  clientUserMessageId?: string;
  signal?: AbortSignal;
  onSession?: (threadId: string) => void;
  onNotification?: (message: JsonObject) => void;
}

export interface CodexTurnClient {
  runTurn(input: CodexTurnInput): Promise<CodexTurnResult>;
  close(): Promise<void>;
}

export class CodexAppServerClient implements CodexTurnClient {
  private readonly rpc: JsonlRpcTransport;
  private readonly options: CodexAppServerOptions;
  private initialized = false;
  private activeTurn: { threadId: string; turnId: string } | undefined;
  private readonly deliveredCommandIds = new Set<string>();

  public constructor(options: CodexAppServerOptions = {}) {
    this.options = options;
    this.rpc =
      options.transportFactory?.() ??
      new JsonlRpcProcess({
        command: options.command ?? "codex",
        args: codexAppServerArguments(options),
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
          name: this.options.clientName ?? "clankie_agent_os",
          title: this.options.clientTitle ?? "Clankie",
          version: this.options.clientVersion ?? "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
    this.rpc.notify({ method: "initialized", params: {} });
    this.initialized = true;
  }

  public async runTurn(input: CodexTurnInput): Promise<CodexTurnResult> {
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
          permissions: input.writeEnabled ? "clankie_native_write" : "clankie_native_read",
          serviceName: "clankie",
        },
      });
      const threadId = readNestedString(started, ["result", "thread", "id"]);
      input.onSession?.(threadId);
      let turnId: string | undefined;
      const terminalWait = new AbortController();
      const completedPromise = waitForMessage(
        this.rpc,
        (message) =>
          message.method === "turn/completed" &&
          readNestedStringOrUndefined(message, ["params", "threadId"]) === threadId &&
          (turnId === undefined || readNestedStringOrUndefined(message, ["params", "turn", "id"]) === turnId),
        this.options.turnTimeoutMs ?? 15 * 60_000,
        terminalWait.signal,
      );
      let turnResponse: JsonObject;
      try {
        turnResponse = await this.rpc.request({
          method: "turn/start",
          params: {
            threadId,
            clientUserMessageId: input.clientUserMessageId,
            cwd: input.cwd,
            approvalPolicy: "never",
            permissions: input.writeEnabled ? "clankie_native_write" : "clankie_native_read",
            input: [{ type: "text", text: input.prompt }],
          },
        });
      } catch (error) {
        terminalWait.abort(error);
        await completedPromise.catch(() => undefined);
        throw error;
      }
      turnId = readNestedString(turnResponse, ["result", "turn", "id"]);
      this.activeTurn = { threadId, turnId };
      const abort = () => {
        void this.rpc
          .request({ method: "turn/interrupt", params: { threadId, turnId } }, 10_000)
          .catch(() => undefined);
      };
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
      let completed: JsonObject;
      try {
        completed = await completedPromise;
      } finally {
        this.activeTurn = undefined;
        input.signal?.removeEventListener("abort", abort);
      }
      if (readNestedStringOrUndefined(completed, ["params", "turn", "id"]) !== turnId) {
        throw new Error("Codex completed an unexpected turn");
      }
      const status = readNestedStringOrUndefined(completed, ["params", "turn", "status"]) ?? "completed";
      return { threadId, turnId, status, text, notifications };
    } finally {
      unsubscribe();
    }
  }

  public async steer(command: WorkerSteerCommand): Promise<void> {
    if (this.deliveredCommandIds.has(command.commandId)) return;
    const active = this.activeTurn;
    if (!active) throw new Error("Codex worker has no active turn to steer");
    const response = await this.rpc.request({
      method: "turn/steer",
      params: {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        clientUserMessageId: command.commandId,
        input: [{ type: "text", text: command.input }],
      },
    });
    const acceptedTurnId = readNestedString(response, ["result", "turnId"]);
    if (acceptedTurnId !== active.turnId) throw new Error("Codex steered an unexpected turn");
    this.deliveredCommandIds.add(command.commandId);
  }

  public close(): Promise<void> {
    return this.rpc.close();
  }

  public async probeUnreadable(path: string): Promise<boolean> {
    await this.initialize();
    const result = await this.rpc.request({
      method: "command/exec",
      params: {
        command: ["/bin/cat", path],
        cwd: this.options.toolEnvironment?.HOME,
        permissionProfile: "clankie_native_read",
        timeoutMs: 3_000,
        outputBytesCap: 1_024,
      },
    });
    const response = asRecord(result.result);
    return typeof response.exitCode === "number" && response.exitCode !== 0 && response.stdout === "";
  }
}

/**
 * Starts Codex with strict, inline permissions so user configuration cannot weaken the tool boundary.
 * The provider parent retains its authentication environment; shell tools inherit none of it.
 */
export function codexAppServerArguments(options: CodexAppServerOptions): string[] {
  const deniedReadPaths = [...new Set(options.deniedReadPaths ?? [])].sort();
  if (deniedReadPaths.length === 0) throw new Error("codex_tool_boundary_denied_paths_required");
  const toolEnvironment = options.toolEnvironment ?? {};
  if (!toolEnvironment.HOME || !toolEnvironment.PATH) {
    throw new Error("codex_tool_boundary_environment_required");
  }
  const args = [
    "app-server",
    "--strict-config",
    "--disable",
    "shell_snapshot",
    "--listen",
    "stdio://",
    "-c",
    'default_permissions="clankie_native_write"',
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    "allow_login_shell=false",
  ];
  const toolHome = toolEnvironment.HOME;
  const writeFilesystem = new Map<string, "read" | "write" | "deny">([
    [":minimal", "read"],
    [toolHome, "write"],
  ]);
  const readFilesystem = new Map<string, "read" | "write" | "deny">([
    [":minimal", "read"],
    [toolHome, "write"],
  ]);
  for (const path of codexToolReadableRoots(toolEnvironment)) {
    writeFilesystem.set(path, "read");
    readFilesystem.set(path, "read");
  }
  for (const path of deniedReadPaths) {
    writeFilesystem.set(path, "deny");
    readFilesystem.set(path, "deny");
  }
  args.push(
    "-c",
    `permissions.clankie_native_write={ filesystem = ${tomlFilesystemTable(writeFilesystem, "write")}, network = { enabled = false } }`,
    "-c",
    `permissions.clankie_native_read={ filesystem = ${tomlFilesystemTable(readFilesystem, "read")}, network = { enabled = false } }`,
  );
  for (const [name, value] of Object.entries(toolEnvironment).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!value || !/^[A-Z][A-Z0-9_]*$/u.test(name)) continue;
    args.push("-c", `shell_environment_policy.set.${name}=${JSON.stringify(value)}`);
  }
  args.push(...codexMcpServerArguments(options.mcpServers ?? []));
  return args;
}

/** Inline-table `-c` overrides declaring each doctrine-projected MCP server. */
export function codexMcpServerArguments(servers: readonly CodexMcpServer[]): string[] {
  const args: string[] = [];
  for (const server of [...servers].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!/^[a-z][a-z0-9_]*$/u.test(server.name)) {
      throw new Error(`codex_mcp_server_name_invalid:${server.name}`);
    }
    const environment = Object.entries(server.env)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${tomlQuotedKey(name)} = ${JSON.stringify(value)}`);
    args.push(
      "-c",
      `mcp_servers.${server.name}={ command = ${JSON.stringify(server.command)}, args = ${JSON.stringify(server.args)}, env = { ${environment.join(", ")} } }`,
    );
  }
  return args;
}

/** Strict-config initialization is the readiness compatibility probe for the named profile boundary. */
export async function probeCodexToolBoundary(
  options: CodexAppServerOptions,
  boundaryProbePath: string,
): Promise<boolean> {
  const client = new CodexAppServerClient(options);
  try {
    return await client.probeUnreadable(boundaryProbePath);
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function tomlQuotedKey(value: string): string {
  return JSON.stringify(value);
}

function tomlFilesystemTable(
  entries: ReadonlyMap<string, "read" | "write" | "deny">,
  workspaceAccess: "read" | "write",
): string {
  const values = [...entries]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, access]) => `${tomlQuotedKey(path)} = ${JSON.stringify(access)}`);
  values.push(`":workspace_roots" = { "." = ${JSON.stringify(workspaceAccess)} }`);
  return `{ ${values.join(", ")} }`;
}

function codexToolReadableRoots(environment: NodeJS.ProcessEnv): string[] {
  const roots = new Set<string>();
  for (const path of environment.PATH?.split(delimiter) ?? []) {
    if (isAbsolute(path)) roots.add(path);
  }
  roots.delete(environment.HOME ?? "");
  return [...roots].sort();
}

export interface CodexWorkerOptions extends CodexAppServerOptions {
  id?: string;
  displayName?: string;
  kinds?: TaskKind[];
}

export class CodexWorkerAdapter implements WorkerAdapter {
  public readonly descriptor: WorkerDescriptor;
  private readonly options: CodexWorkerOptions;
  private readonly activeClients = new Map<string, CodexAppServerClient>();

  public constructor(options: CodexWorkerOptions = {}) {
    this.options = options;
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
    if (context.signal.aborted) return cancelledWorkerResult(context.workerRunId, "Codex");
    const mcpServers = (this.options.mcpServers ?? []).filter(
      (server) => !server.kinds || server.kinds.includes(context.task.kind),
    );
    const client = new CodexAppServerClient({ ...this.options, mcpServers });
    this.activeClients.set(context.workerRunId, client);
    const writeEnabled = ["implementation", "debugging", "integration", "design"].includes(context.task.kind);
    try {
      const result = await client.runTurn({
        cwd: context.workspacePath,
        prompt: renderTaskPrompt(context),
        writeEnabled,
        clientUserMessageId: `${context.workerRunId}:${context.attempt}`,
        signal: context.signal,
        onSession: (nativeSessionId) => {
          context.emit({
            type: "worker.native_session.bound",
            missionId: context.missionId,
            taskId: context.task.id,
            workerRunId: context.workerRunId,
            profileHash: context.profileHash,
            data: { provider: "codex", nativeSessionId },
          });
        },
        onNotification: (notification) => {
          const method = typeof notification.method === "string" ? notification.method : "codex.notification";
          if (method === "turn/started") {
            emitWorkerTurnStarted(context, "codex.app_server");
          } else if (method === "turn/completed") {
            emitWorkerTurnSettled(context, "codex.app_server");
          } else if (isCodexWaitingUserRequest(method)) {
            emitWorkerWaitingUser(
              context,
              "codex.app_server",
              summarizeCodexWaitingRequest(method, notification.params),
            );
          }
          const semanticEvent = completedCodexItem(notification);
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
          workerRunId: context.workerRunId,
          nativeSessionId: result.threadId,
          nativeTurnId: result.turnId,
          notificationCount: result.notifications.length,
        },
        ...(succeeded ? {} : { diagnosis: `Codex turn status was ${result.status}` }),
      };
    } finally {
      this.activeClients.delete(context.workerRunId);
      await client.close().catch(() => undefined);
    }
  }

  public async steer(runId: string, command: WorkerSteerCommand): Promise<void> {
    if (command.workerRunId !== runId) throw new Error("Steer command worker run mismatch");
    const client = this.activeClients.get(runId);
    if (!client) throw new Error(`No active Codex client for worker run ${runId}`);
    await client.steer(command);
  }
}

type CompletedCodexItem = {
  type: "worker.command.completed" | "worker.file_change.completed";
  data: Record<string, unknown>;
};

/** Converts authoritative item/completed payloads without forwarding commands, patches, or output. */
export function completedCodexItem(notification: JsonObject): CompletedCodexItem | undefined {
  if (notification.method !== "item/completed") return undefined;
  const item = asRecord(asRecord(notification.params).item);
  const itemType = item.type;
  if (itemType === "commandExecution") {
    const command = typeof item.command === "string" ? item.command : "";
    const exitCode =
      typeof item.exitCode === "number" && Number.isInteger(item.exitCode) ? item.exitCode : null;
    return {
      type: "worker.command.completed",
      data: {
        provider: "codex",
        commandFingerprint: fingerprint(command),
        exitCode,
        result: exitCode === 0 ? "passed" : "failed",
      },
    };
  }
  if (itemType === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const pathFingerprints = changes
      .map((change) => asRecord(change).path)
      .filter((path): path is string => typeof path === "string")
      .map(fingerprint)
      .sort();
    return {
      type: "worker.file_change.completed",
      data: {
        provider: "codex",
        changeCount: changes.length,
        pathFingerprints,
        result: item.status === "completed" ? "passed" : "failed",
      },
    };
  }
  return undefined;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function renderTaskPrompt(context: WorkerRunContext): string {
  return [
    "You are a worker in a governed multi-agent mission.",
    `Mission: ${context.missionId}`,
    `Task ${context.task.id}: ${context.task.title}`,
    `Role: ${context.task.role}`,
    `Objective: ${context.task.objective}`,
    `Success criteria:\n${context.task.successCriteria.map((item) => `- ${item}`).join("\n")}`,
    `Required evidence:\n${context.task.evidenceRequirements.map((item) => `- ${item}`).join("\n")}`,
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

const CODEX_WAITING_USER_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

function isCodexWaitingUserRequest(method: string): boolean {
  return CODEX_WAITING_USER_METHODS.has(method);
}

function summarizeCodexWaitingRequest(method: string, value: unknown): string {
  const params = asRecord(value);
  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const first = asRecord(questions[0]);
    if (typeof first.question === "string" && first.question.trim()) return first.question;
  }
  for (const key of ["message", "reason", "command"] as const) {
    const summary = params[key];
    if (typeof summary === "string" && summary.trim()) return summary;
  }
  if (method === "item/fileChange/requestApproval" && typeof params.grantRoot === "string") {
    return `Approve writes under ${params.grantRoot}?`;
  }
  return `Approval required: ${method}`;
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
