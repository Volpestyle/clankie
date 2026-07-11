import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { TaskKind, WorkerResult } from "@sapling/protocol";
import type { WorkerAdapter, WorkerDescriptor, WorkerRunContext } from "@sapling/worker-sdk";

export interface ClaudeWorkerOptions {
  id?: string;
  displayName?: string;
  model?: string;
  kinds?: TaskKind[];
  maxTurns?: number;
  settingSources?: Array<"user" | "project" | "local">;
}

type ClaudeMessage = Record<string, unknown>;
type ClaudeQuery = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<ClaudeMessage>;

const query = sdkQuery as unknown as ClaudeQuery;

export class ClaudeWorkerAdapter implements WorkerAdapter {
  public readonly descriptor: WorkerDescriptor;

  public constructor(private readonly options: ClaudeWorkerOptions = {}) {
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
    const writeEnabled = ["implementation", "debugging", "integration", "design"].includes(context.task.kind);
    const allowedTools = writeEnabled
      ? ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]
      : ["Read", "Glob", "Grep", "Bash"];
    let resultText = "";
    let sessionId: string | undefined;
    let failed = false;
    let diagnosis: string | undefined;
    let messageCount = 0;

    const stream = query({
      prompt: renderClaudePrompt(context),
      options: {
        cwd: context.workspacePath,
        model: this.options.model,
        allowedTools,
        maxTurns: this.options.maxTurns ?? 24,
        permissionMode: writeEnabled ? "acceptEdits" : "default",
        settingSources: this.options.settingSources ?? ["project"],
      },
    });

    for await (const message of stream) {
      if (context.signal.aborted) throw new Error("Claude Agent SDK run aborted");
      messageCount += 1;
      if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
        sessionId = message.session_id;
      }
      if (typeof message.result === "string") resultText = message.result;
      if (message.type === "result") {
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
        profileHash: context.profileHash,
        data: summarizeClaudeMessage(message),
      });
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
      outputs: { nativeSessionId: sessionId ?? null, messageCount },
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
