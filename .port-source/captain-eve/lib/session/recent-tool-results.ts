import { wrapLanguageModel, type JSONValue, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { defineState } from "eve/context";

/**
 * Tool output retained across compaction, measured with Eve's JSON/4 estimate.
 * The newest complete result is always retained even when it alone exceeds the
 * budget; otherwise one oversized result would erase the only continuity fact.
 */
export const PROTECTED_TOOL_RESULT_TOKENS = 20_000;
const MAX_PENDING_TOOL_CALLS = 64;

type ToolResultStatus = "completed" | "failed" | "rejected";

export interface ProtectedToolExchange {
  readonly callId: string;
  readonly toolName: string;
  readonly input: JSONValue;
  readonly output: JSONValue;
  readonly status: ToolResultStatus;
}

interface PendingToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly input: JSONValue;
}

export interface RecentToolResultState {
  readonly pending: readonly PendingToolCall[];
  readonly protected: readonly ProtectedToolExchange[];
}

interface ActionRequest {
  readonly callId: string;
  readonly input: unknown;
  readonly kind: "load-skill" | "remote-agent-call" | "subagent-call" | "tool-call";
  readonly name?: string | undefined;
  readonly toolName?: string | undefined;
}

interface ActionResult {
  readonly callId: string;
  readonly isError?: boolean | undefined;
  readonly kind: "load-skill-result" | "subagent-result" | "tool-result";
  readonly name?: string | undefined;
  readonly output: unknown;
  readonly subagentName?: string | undefined;
  readonly toolName?: string | undefined;
}

/**
 * Private, workflow-owned state. Raw tool inputs and outputs stay inside Eve's
 * durable session and never enter the Clankie event-store projection.
 */
export const recentToolResultState = defineState<RecentToolResultState>(
  "clankie.captain.recent-tool-results.v1",
  () => ({ pending: [], protected: [] }),
);

function requestToolName(request: ActionRequest): string {
  if (request.kind === "tool-call") return request.toolName ?? "unknown_tool";
  if (request.kind === "load-skill") return "load_skill";
  return request.name ?? "agent";
}

function resultToolName(result: ActionResult): string {
  if (result.kind === "tool-result") return result.toolName ?? "unknown_tool";
  if (result.kind === "load-skill-result") return "load_skill";
  return result.name ?? result.subagentName ?? "agent";
}

/** Idempotently remembers model-emitted tool calls until their results arrive. */
export function recordActionRequests(
  state: RecentToolResultState,
  requests: readonly ActionRequest[],
): RecentToolResultState {
  let pending = [...state.pending];
  for (const request of requests) {
    pending = pending.filter((entry) => entry.callId !== request.callId);
    pending.push({
      callId: request.callId,
      toolName: requestToolName(request),
      input: request.input as JSONValue,
    });
  }
  if (pending.length > MAX_PENDING_TOOL_CALLS) pending = pending.slice(-MAX_PENDING_TOOL_CALLS);
  return { ...state, pending };
}

/** Idempotently completes one call/result pair and applies the recent-token budget. */
export function recordActionResult(
  state: RecentToolResultState,
  result: ActionResult,
  status: ToolResultStatus,
  tokenBudget = PROTECTED_TOOL_RESULT_TOKENS,
): RecentToolResultState {
  const pending = state.pending.find((entry) => entry.callId === result.callId);
  const existing = state.protected.find((entry) => entry.callId === result.callId);
  const exchange: ProtectedToolExchange = {
    callId: result.callId,
    toolName: pending?.toolName ?? existing?.toolName ?? resultToolName(result),
    input: pending?.input ?? existing?.input ?? {},
    output: result.output as JSONValue,
    status: result.isError === true && status === "completed" ? "failed" : status,
  };
  return {
    pending: state.pending.filter((entry) => entry.callId !== result.callId),
    protected: pruneProtectedToolExchanges(
      [...state.protected.filter((entry) => entry.callId !== result.callId), exchange],
      tokenBudget,
    ),
  };
}

function estimatedTokens(value: unknown): number {
  return (JSON.stringify(value) ?? "null").length / 4;
}

/** Keeps newest complete exchanges within budget, always retaining the newest one. */
export function pruneProtectedToolExchanges(
  exchanges: readonly ProtectedToolExchange[],
  tokenBudget = PROTECTED_TOOL_RESULT_TOKENS,
): readonly ProtectedToolExchange[] {
  if (exchanges.length === 0) return [];
  const retained: ProtectedToolExchange[] = [];
  let tokens = 0;
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    const exchange = exchanges[index];
    if (exchange === undefined) continue;
    const exchangeTokens = estimatedTokens(exchange);
    if (retained.length > 0 && tokens + exchangeTokens > tokenBudget) break;
    retained.push(exchange);
    tokens += exchangeTokens;
  }
  return retained.reverse();
}

export type ProviderPrompt = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"]["prompt"];

function promptToolIds(prompt: ProviderPrompt): { calls: Set<string>; results: Set<string> } {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of prompt) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.add(part.toolCallId);
      if (part.type === "tool-result") results.add(part.toolCallId);
    }
  }
  return { calls, results };
}

function toolResultOutput(exchange: ProtectedToolExchange) {
  if (exchange.status === "failed") return { type: "error-json" as const, value: exchange.output };
  if (exchange.status === "rejected") {
    return {
      type: "execution-denied" as const,
      reason: typeof exchange.output === "string" ? exchange.output : JSON.stringify(exchange.output),
    };
  }
  return { type: "json" as const, value: exchange.output };
}

/**
 * Restores only call/result pairs missing from the provider prompt. Eve 0.24.4
 * strips both parts during compaction; ordinary un-compacted calls are left
 * byte-for-byte alone and never duplicated.
 */
export function appendProtectedToolExchanges(
  prompt: ProviderPrompt,
  exchanges: readonly ProtectedToolExchange[],
): ProviderPrompt {
  if (exchanges.length === 0) return prompt;
  const restored = [...prompt];
  const ids = promptToolIds(prompt);
  for (const exchange of exchanges) {
    if (!ids.calls.has(exchange.callId)) {
      restored.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: exchange.callId,
            toolName: exchange.toolName,
            input: exchange.input,
          },
        ],
      });
      ids.calls.add(exchange.callId);
    }
    if (!ids.results.has(exchange.callId)) {
      restored.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: exchange.callId,
            toolName: exchange.toolName,
            output: toolResultOutput(exchange),
          },
        ],
      });
      ids.results.add(exchange.callId);
    }
  }
  return restored;
}

/** Wraps both Eve's compaction summary call and the following continuation call. */
export function protectRecentToolResultModel(
  model: LanguageModel,
  exchanges: readonly ProtectedToolExchange[],
): LanguageModel {
  if (exchanges.length === 0 || typeof model === "string") return model;
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        prompt: appendProtectedToolExchanges(params.prompt, exchanges),
      }),
    },
  });
}
