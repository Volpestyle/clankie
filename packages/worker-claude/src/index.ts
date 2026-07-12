import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  query as sdkQuery,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
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

/**
 * One MCP server pre-approved by the runner's doctrine projection. The
 * adapter treats this as opaque, already-authorized configuration: it never
 * widens `allowedTools`, and servers scoped to `kinds` stay invisible to
 * every other task kind.
 */
export interface ClaudeMcpServer {
  name: string;
  /** Task kinds allowed to see this server. Omitted means every kind. */
  kinds?: TaskKind[];
  /** Claude Agent SDK-shaped server config (stdio command/args/env or http url). */
  config: Record<string, unknown>;
  /** Bare tool names doctrine allows on this server. */
  allowedTools: string[];
}

export type ClaudeWebTool = "WebSearch" | "WebFetch";

export interface ClaudeWorkerOptions {
  id?: string;
  displayName?: string;
  model?: string;
  kinds?: TaskKind[];
  maxTurns?: number;
  /** Doctrine-projected MCP servers supplied by the runner. */
  mcpServers?: ClaudeMcpServer[];
  /** Native provider web tools granted by the runner; applied to research tasks only. */
  webTools?: ClaudeWebTool[];
  settingSources?: Array<"user" | "project" | "local">;
  pathToClaudeCodeExecutable?: string;
  credentialEnvironmentVariables?: string[];
  credentialFiles?: string[];
  /** Refuse to start unless the runner supplied a synthetic HOME and explicit protected paths. */
  requireCredentialBoundary?: boolean;
  query?: ClaudeQuery;
  canUseTool?: CanUseTool;
  /**
   * Allowlisted worker environment forwarded verbatim to the Claude Agent SDK
   * subprocess. When supplied, it replaces the inherited process environment
   * entirely, so runner, captain, connector, and organization secrets never
   * reach the worker unless the runner explicitly allowlisted them. When
   * omitted, the SDK subprocess inherits `process.env` (default behavior).
   */
  environment?: NodeJS.ProcessEnv;
}

export type ClaudeMessage = Record<string, unknown>;
export type ClaudeQuery = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<ClaudeMessage>;

const defaultQuery = sdkQuery as unknown as ClaudeQuery;
export const CLAUDE_AGENT_SDK_VERSION = "0.3.206";

const DEFAULT_CLAUDE_CREDENTIAL_ENVIRONMENT_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

export class ClaudeWorkerAdapter implements WorkerAdapter {
  public readonly descriptor: WorkerDescriptor;
  private readonly options: ClaudeWorkerOptions;

  public constructor(options: ClaudeWorkerOptions = {}) {
    this.options = options;
    this.descriptor = {
      id: options.id ?? "claude-agent-sdk",
      displayName: options.displayName ?? "Claude Agent",
      harness: "claude" as const,
      ...(options.model ? { model: options.model } : {}),
      capabilities: {
        kinds: options.kinds ?? [
          "research",
          "implementation",
          "debugging",
          "verification",
          "review",
          "evaluation",
        ],
        canWrite: true,
        supportsStructuredEvents: true,
        supportsTerminal: false,
        supportsNativeSession: true,
      },
    };
  }

  public async run(context: WorkerRunContext): Promise<WorkerResult> {
    if (context.signal.aborted) return cancelledWorkerResult(context.workerRunId, "Claude");
    if (this.options.requireCredentialBoundary) assertCredentialBoundary(this.options);
    const writeEnabled = ["implementation", "debugging", "integration", "design"].includes(context.task.kind);
    const webTools = context.task.kind === "research" ? (this.options.webTools ?? []) : [];
    const mcpServers = (this.options.mcpServers ?? []).filter(
      (server) => !server.kinds || server.kinds.includes(context.task.kind),
    );
    const mcpToolNames = mcpServers.flatMap((server) =>
      server.allowedTools.map((tool) => `mcp__${server.name}__${tool}`),
    );
    const nativeTools = [
      ...(writeEnabled ? ["Read", "Glob", "Grep", "Edit", "Write"] : ["Read", "Glob", "Grep"]),
      ...webTools,
    ];
    const allowedTools = [...nativeTools, ...mcpToolNames];
    const grantedTools = new Set<string>([...webTools, ...mcpToolNames]);
    let resultText = "";
    let sessionId: string | undefined;
    let failed = false;
    let diagnosis: string | undefined;
    let messageCount = 0;
    const pendingTools = new Map<string, PendingClaudeTool>();
    const abortController = new AbortController();
    const abort = () => abortController.abort(context.signal.reason);
    if (context.signal.aborted) abort();
    else context.signal.addEventListener("abort", abort, { once: true });

    const stream = (this.options.query ?? defaultQuery)({
      prompt: renderClaudePrompt(context),
      options: {
        cwd: context.workspacePath,
        model: this.options.model,
        allowedTools,
        maxTurns: this.options.maxTurns ?? 24,
        permissionMode: writeEnabled ? "acceptEdits" : "dontAsk",
        settingSources: this.options.settingSources ?? [],
        tools: nativeTools,
        disallowedTools: writeEnabled ? ["Bash"] : ["Edit", "Write", "Bash"],
        pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable,
        sandbox: claudeSandboxSettings(this.options, writeEnabled ? [] : [context.workspacePath]),
        settings: claudeSessionSettings(this.options),
        hooks: {
          PreToolUse: [{ hooks: [claudeCandidateToolHook(context.workspacePath, grantedTools)] }],
        },
        ...(mcpServers.length > 0
          ? { mcpServers: Object.fromEntries(mcpServers.map((server) => [server.name, server.config])) }
          : {}),
        abortController,
        ...(this.options.environment ? { env: this.options.environment } : {}),
        ...(this.options.canUseTool
          ? {
              canUseTool: async (...args: Parameters<CanUseTool>) => {
                emitWorkerWaitingUser(
                  context,
                  "claude.agent_sdk",
                  summarizeClaudePermission(args[0], args[2]),
                );
                const decision = await this.options.canUseTool?.(...args);
                emitWorkerTurnStarted(context, "claude.agent_sdk");
                return decision ?? null;
              },
            }
          : {}),
      },
    });

    try {
      for await (const message of stream) {
        if (context.signal.aborted) throw new Error("Claude Agent SDK run aborted");
        messageCount += 1;
        if (message.type === "assistant") {
          emitWorkerTurnStarted(context, "claude.agent_sdk");
        }
        if (
          !sessionId &&
          message.type === "system" &&
          message.subtype === "init" &&
          typeof message.session_id === "string"
        ) {
          sessionId = message.session_id;
          context.emit({
            type: "worker.native_session.bound",
            missionId: context.missionId,
            taskId: context.task.id,
            workerRunId: context.workerRunId,
            profileHash: context.profileHash,
            data: { provider: "claude", nativeSessionId: sessionId },
          });
        }
        if (typeof message.result === "string") resultText = message.result;
        if (message.type === "result") {
          emitWorkerTurnSettled(context, "claude.agent_sdk");
          failed = message.is_error === true;
          if (failed)
            diagnosis =
              typeof message.result === "string"
                ? message.result
                : "Claude Agent SDK returned an error result.";
        }
        for (const event of completedClaudeToolEvents(message, pendingTools)) {
          context.emit({
            type: event.type,
            missionId: context.missionId,
            taskId: context.task.id,
            workerRunId: context.workerRunId,
            profileHash: context.profileHash,
            data: event.data,
          });
        }
        context.emit({
          type: `provider.claude.${String(message.type ?? "message")}`,
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: context.workerRunId,
          profileHash: context.profileHash,
          data: summarizeClaudeMessage(message),
        });
      }
    } finally {
      context.signal.removeEventListener("abort", abort);
    }

    return {
      status: failed ? "failed" : "succeeded",
      summary: resultText.trim() || `Claude Agent SDK completed after ${messageCount} messages.`,
      evidence: [
        {
          kind: "log",
          label: "claude-agent-sdk-session",
          summary: `session=${sessionId ?? "unknown"} messages=${messageCount}`,
        },
      ],
      outputs: { workerRunId: context.workerRunId, nativeSessionId: sessionId ?? null, messageCount },
      ...(diagnosis ? { diagnosis } : {}),
    };
  }
}

function assertCredentialBoundary(options: ClaudeWorkerOptions): void {
  if (!options.environment?.HOME?.trim() || !options.environment.PATH?.trim()) {
    throw new Error("claude_tool_boundary_environment_required");
  }
  if (!options.credentialFiles?.length) throw new Error("claude_tool_boundary_denied_paths_required");
}

/**
 * Programmatic hook that makes the candidate root the only model-tool
 * filesystem authority. Non-filesystem tools pass only when the runner
 * granted them explicitly (web tools and doctrine-projected MCP tools).
 */
export function claudeCandidateToolHook(
  workspacePath: string,
  grantedTools: ReadonlySet<string> = new Set(),
): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = asRecord(input.tool_input);
    if (!(await claudeToolAccessAllowed(input.tool_name, toolInput, workspacePath, grantedTools))) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Provider tools may read or write only inside the assigned candidate root.",
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    };
  };
}

async function claudeToolAccessAllowed(
  toolName: string,
  input: Record<string, unknown>,
  workspacePath: string,
  grantedTools: ReadonlySet<string>,
): Promise<boolean> {
  if (grantedTools.has(toolName)) return true;
  if (["Read", "Edit", "Write"].includes(toolName)) {
    return typeof input.file_path === "string" && input.file_path.trim().length > 0
      ? pathInsideCandidate(input.file_path, workspacePath)
      : false;
  }
  if (toolName === "Glob") {
    if (!safeGlobPattern(input.pattern)) return false;
    const base = searchBasePath(input.path, workspacePath);
    return base !== undefined && pathInsideCandidate(base, workspacePath);
  }
  if (toolName === "Grep") {
    if (typeof input.pattern !== "string" || !input.pattern.trim() || input.pattern.includes("\0")) {
      return false;
    }
    if (input.glob !== undefined && !safeGlobPattern(input.glob)) return false;
    const base = searchBasePath(input.path, workspacePath);
    return base !== undefined && pathInsideCandidate(base, workspacePath);
  }
  return false;
}

function searchBasePath(value: unknown, workspacePath: string): string | undefined {
  if (value === undefined) return workspacePath;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function safeGlobPattern(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const pattern = value.trim();
  if (
    !pattern ||
    pattern.includes("\0") ||
    pattern.includes("\\") ||
    pattern.includes("..") ||
    pattern.includes("{") ||
    pattern.includes("}") ||
    /[?*+@!]\(/u.test(pattern) ||
    pattern.startsWith("~") ||
    isAbsolute(pattern)
  ) {
    return false;
  }
  return true;
}

async function pathInsideCandidate(requestedPath: string, workspacePath: string): Promise<boolean> {
  const lexicalWorkspace = resolve(workspacePath);
  const requested = resolve(lexicalWorkspace, requestedPath);
  if (!isContained(lexicalWorkspace, requested)) return false;
  const workspace = await realpath(lexicalWorkspace).catch(() => lexicalWorkspace);
  const canonical = await realpath(requested).catch(() => requested);
  return isContained(workspace, canonical);
}

function isContained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

type PendingClaudeTool = { kind: "command" | "file"; fingerprint: string };
type CompletedClaudeToolEvent = {
  type: "worker.command.completed" | "worker.file_change.completed";
  data: Record<string, unknown>;
};

/** Tracks structured tool_use/tool_result pairs and emits only minimized completion facts. */
export function completedClaudeToolEvents(
  message: ClaudeMessage,
  pending: Map<string, PendingClaudeTool>,
): CompletedClaudeToolEvent[] {
  const messageRecord = asRecord(message.message);
  const content = Array.isArray(messageRecord.content) ? messageRecord.content : [];
  if (message.type === "assistant") {
    for (const value of content) {
      const block = asRecord(value);
      if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") {
        continue;
      }
      const input = asRecord(block.input);
      if (block.name === "Bash") {
        pending.set(block.id, {
          kind: "command",
          fingerprint: fingerprint(typeof input.command === "string" ? input.command : ""),
        });
      } else if (block.name === "Edit" || block.name === "Write") {
        pending.set(block.id, {
          kind: "file",
          fingerprint: fingerprint(typeof input.file_path === "string" ? input.file_path : ""),
        });
      }
    }
    return [];
  }
  if (message.type !== "user") return [];
  const completed: CompletedClaudeToolEvent[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    const tool = pending.get(block.tool_use_id);
    if (!tool) continue;
    pending.delete(block.tool_use_id);
    const result = block.is_error === true ? "failed" : "passed";
    completed.push(
      tool.kind === "command"
        ? {
            type: "worker.command.completed",
            data: {
              provider: "claude",
              commandFingerprint: tool.fingerprint,
              exitCode: result === "passed" ? 0 : null,
              result,
            },
          }
        : {
            type: "worker.file_change.completed",
            data: {
              provider: "claude",
              changeCount: 1,
              pathFingerprints: [tool.fingerprint],
              result,
            },
          },
    );
  }
  return completed;
}

function claudeSandboxSettings(
  options: ClaudeWorkerOptions,
  additionalDeniedWritePaths: string[],
): Record<string, unknown> {
  const credentialEnvironmentVariables = options.credentialEnvironmentVariables ?? [
    ...DEFAULT_CLAUDE_CREDENTIAL_ENVIRONMENT_VARIABLES,
  ];
  const credentialFiles = options.credentialFiles ?? [join(homedir(), ".claude")];
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: credentialFiles,
      denyWrite: [...credentialFiles, ...additionalDeniedWritePaths],
    },
    credentials: {
      files: credentialFiles.map((path) => ({ path, mode: "deny" })),
      envVars: credentialEnvironmentVariables.map((name) => ({ name, mode: "deny" })),
    },
  };
}

function claudeSessionSettings(options: ClaudeWorkerOptions): Record<string, unknown> {
  const credentialFiles = options.credentialFiles ?? [join(homedir(), ".claude")];
  return {
    disableBundledSkills: true,
    permissions: {
      deny: credentialFiles.flatMap((path) => [`Read(${path})`, `Read(${path}/**)`]),
      disableBypassPermissionsMode: "disable",
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

export function renderClaudePrompt(context: WorkerRunContext): string {
  const readOnly = context.task.writeScope.length === 0;
  return [
    "You are a specialized worker. The lead owns intent and integration; you own only this task.",
    `Mission: ${context.missionId}`,
    `Task ${context.task.id}: ${context.task.title}`,
    `Role: ${context.task.role}`,
    `Objective: ${context.task.objective}`,
    `Success criteria:\n${context.task.successCriteria.map((item) => `- ${item}`).join("\n")}`,
    `Required evidence:\n${context.task.evidenceRequirements.map((item) => `- ${item}`).join("\n")}`,
    `Allowed write scope:\n${readOnly ? "- none (read-only verification/review)" : context.task.writeScope.map((item) => `- ${item}`).join("\n")}`,
    "Do not change acceptance tests to conceal a defect. Do not merge, deploy, publish, or mutate work trackers.",
    "Verify your claims and return exact commands, evidence, risks, and any blocker requiring the lead.",
  ].join("\n\n");
}

function summarizeClaudeMessage(message: ClaudeMessage): Record<string, unknown> {
  return {
    type: message.type ?? "message",
    subtype: message.subtype ?? null,
    sessionId: message.session_id ?? null,
    parentToolUseId: message.parent_tool_use_id ?? null,
    isError: message.is_error ?? false,
  };
}

function summarizeClaudePermission(toolName: string, options: Parameters<CanUseTool>[2]): string {
  for (const candidate of [options.title, options.description, options.decisionReason]) {
    if (candidate?.trim()) return candidate;
  }
  return `Approval required for ${toolName}`;
}
