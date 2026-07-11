import { query as sdkQuery, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
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

export interface ClaudeWorkerOptions {
  id?: string;
  displayName?: string;
  model?: string;
  kinds?: TaskKind[];
  maxTurns?: number;
  settingSources?: Array<"user" | "project" | "local">;
  query?: ClaudeQuery;
  canUseTool?: CanUseTool;
}

export type ClaudeMessage = Record<string, unknown>;
export type ClaudeQuery = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<ClaudeMessage>;

const defaultQuery = sdkQuery as unknown as ClaudeQuery;

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
    const writeEnabled = ["implementation", "debugging", "integration", "design"].includes(context.task.kind);
    const allowedTools = writeEnabled
      ? ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]
      : ["Read", "Glob", "Grep", "Bash"];
    let resultText = "";
    let sessionId: string | undefined;
    let failed = false;
    let diagnosis: string | undefined;
    let messageCount = 0;
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
        permissionMode: writeEnabled ? "acceptEdits" : "default",
        settingSources: this.options.settingSources ?? ["project"],
        abortController,
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
