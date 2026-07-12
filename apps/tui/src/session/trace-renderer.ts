import { sanitizeForSupportBundle } from "@clankie/observability";
import type { HandleMessageStreamEvent } from "eve/client";
import type { TraceLane, TracedStreamEvent } from "./trace-types.ts";

const RESULT_PREVIEW_CHARS = 240;
const ARG_SUMMARY_CHARS = 320;

export type TraceRenderMode = "human" | "json";

export interface TraceRenderLine {
  readonly kind:
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "message"
    | "boundary"
    | "compaction"
    | "tokens"
    | "other";
  readonly lane: TraceLane;
  readonly text: string;
  readonly json: Record<string, unknown>;
}

function actionName(
  action: Extract<HandleMessageStreamEvent, { type: "actions.requested" }>["data"]["actions"][number],
): string {
  switch (action.kind) {
    case "tool-call":
      return action.toolName;
    case "load-skill":
      return typeof action.input.skill === "string" ? action.input.skill : "load_skill";
    case "subagent-call":
      return action.subagentName;
    case "remote-agent-call":
      return action.remoteAgentName;
  }
}

function resultName(
  result: Extract<HandleMessageStreamEvent, { type: "action.result" }>["data"]["result"],
): string {
  switch (result.kind) {
    case "tool-result":
      return result.toolName;
    case "load-skill-result":
      return result.name ?? "load_skill";
    case "subagent-result":
      return result.subagentName;
  }
}

function summarizeArgs(input: unknown): string {
  const sanitized = sanitizeForSupportBundle(input);
  const text = JSON.stringify(sanitized) ?? "null";
  if (text.length <= ARG_SUMMARY_CHARS) return text;
  return `${text.slice(0, ARG_SUMMARY_CHARS)}…`;
}

function summarizeOutput(output: unknown): string {
  const sanitized = sanitizeForSupportBundle(output);
  const text = typeof sanitized === "string" ? sanitized : (JSON.stringify(sanitized) ?? String(sanitized));
  if (text.length <= RESULT_PREVIEW_CHARS) return text;
  return `${text.slice(0, RESULT_PREVIEW_CHARS)}…`;
}

function laneTag(lane: TraceLane): string {
  return `[${lane}]`;
}

/**
 * Pure render of one stream event with a typed lane label.
 * Redacts secrets via the central support-bundle sanitizer (no local secret-key list).
 * Does not write to disk.
 */
export function renderTraceEvent(
  traced: TracedStreamEvent<HandleMessageStreamEvent>,
): readonly TraceRenderLine[] {
  const { lane, event } = traced;
  const lines: TraceRenderLine[] = [];

  switch (event.type) {
    case "reasoning.appended": {
      const delta = event.data.reasoningDelta;
      if (delta.length === 0) break;
      lines.push({
        kind: "reasoning",
        lane,
        text: `${laneTag(lane)} reasoning ${delta}`,
        json: {
          type: event.type,
          lane,
          reasoningDelta: delta,
          ...(traced.sessionId === undefined ? {} : { sessionId: traced.sessionId }),
          ...(traced.streamIndex === undefined ? {} : { streamIndex: traced.streamIndex }),
        },
      });
      break;
    }
    case "reasoning.completed":
      lines.push({
        kind: "reasoning",
        lane,
        text: `${laneTag(lane)} reasoning · completed`,
        json: {
          type: event.type,
          lane,
          ...(traced.sessionId === undefined ? {} : { sessionId: traced.sessionId }),
        },
      });
      break;
    case "actions.requested":
      for (const action of event.data.actions) {
        const name = actionName(action);
        const args = summarizeArgs(action.input);
        lines.push({
          kind: "tool_call",
          lane,
          text: `${laneTag(lane)} tool ${name}(${args})`,
          json: {
            type: event.type,
            lane,
            callId: action.callId,
            name,
            input: sanitizeForSupportBundle(action.input),
            ...(traced.sessionId === undefined ? {} : { sessionId: traced.sessionId }),
          },
        });
      }
      break;
    case "action.result": {
      const name = resultName(event.data.result);
      const failed = event.data.status === "failed" || event.data.result.isError === true;
      const preview = summarizeOutput(event.data.result.output);
      lines.push({
        kind: "tool_result",
        lane,
        text: `${laneTag(lane)} tool-result ${name} ${failed ? "failed" : "ok"} ${preview}`,
        json: {
          type: event.type,
          lane,
          callId: event.data.result.callId,
          name,
          status: event.data.status,
          output: sanitizeForSupportBundle(event.data.result.output),
          ...(traced.sessionId === undefined ? {} : { sessionId: traced.sessionId }),
        },
      });
      break;
    }
    case "message.appended": {
      const delta = event.data.messageDelta;
      if (delta.length === 0) break;
      lines.push({
        kind: "message",
        lane,
        text: `${laneTag(lane)} message ${delta}`,
        json: {
          type: event.type,
          lane,
          messageDelta: delta,
          ...(traced.sessionId === undefined ? {} : { sessionId: traced.sessionId }),
        },
      });
      break;
    }
    case "message.completed":
      lines.push({
        kind: "message",
        lane,
        text: `${laneTag(lane)} message · completed`,
        json: {
          type: event.type,
          lane,
          ...(traced.sessionId === undefined ? {} : { sessionId: traced.sessionId }),
        },
      });
      break;
    case "turn.started":
    case "turn.completed":
    case "session.waiting":
    case "session.completed":
    case "session.failed":
      lines.push({
        kind: "boundary",
        lane,
        text: `${laneTag(lane)} --- ${event.type} ---`,
        json: {
          type: event.type,
          lane,
          ...(traced.sessionId === undefined ? {} : { sessionId: traced.sessionId }),
          ...(traced.streamIndex === undefined ? {} : { streamIndex: traced.streamIndex }),
        },
      });
      break;
    case "compaction.requested":
    case "compaction.completed":
      lines.push({
        kind: "compaction",
        lane,
        text: `${laneTag(lane)} ${event.type}`,
        json: {
          type: event.type,
          lane,
          ...(traced.sessionId === undefined ? {} : { sessionId: traced.sessionId }),
        },
      });
      break;
    case "step.completed": {
      const usage = event.data.usage;
      const summary =
        usage === undefined
          ? "tokens · unavailable"
          : `tokens ↑ ${usage.inputTokens ?? 0} ↓ ${usage.outputTokens ?? 0}`;
      lines.push({
        kind: "tokens",
        lane,
        text: `${laneTag(lane)} ${summary}`,
        json: {
          type: event.type,
          lane,
          usage: usage === undefined ? undefined : sanitizeForSupportBundle(usage),
          ...(traced.sessionId === undefined ? {} : { sessionId: traced.sessionId }),
        },
      });
      break;
    }
    case "session.started":
    case "step.started":
    case "step.failed":
    case "turn.failed":
    case "message.received":
    case "input.requested":
    case "authorization.required":
    case "authorization.completed":
    case "subagent.called":
    case "subagent.started":
    case "subagent.event":
    case "subagent.completed":
    case "result.completed":
      lines.push({
        kind: "other",
        lane,
        text: `${laneTag(lane)} ${event.type}`,
        json: {
          type: event.type,
          lane,
          ...(traced.sessionId === undefined ? {} : { sessionId: traced.sessionId }),
        },
      });
      break;
  }

  return lines;
}

export function formatTraceLines(
  lines: readonly TraceRenderLine[],
  mode: TraceRenderMode,
): readonly string[] {
  if (mode === "json") {
    return lines.map((line) => JSON.stringify(line.json));
  }
  return lines.map((line) => {
    if (line.kind === "reasoning") {
      // Dim + italic for reasoning deltas (ANSI SGR); still human-readable without color support.
      return `\u001B[2m\u001B[3m${line.text}\u001B[0m`;
    }
    return line.text;
  });
}

/** Render a batch of typed multi-lane events into ordered output lines. */
export function renderTraceEvents(
  events: readonly TracedStreamEvent<HandleMessageStreamEvent>[],
  mode: TraceRenderMode = "human",
): readonly string[] {
  const lines: string[] = [];
  for (const traced of events) {
    lines.push(...formatTraceLines(renderTraceEvent(traced), mode));
  }
  return lines;
}
