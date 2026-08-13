import {
  OPERATOR_CONVERSATION_INPUT_OPTIONS_MAX,
  OPERATOR_CONVERSATION_SUMMARY_MAX,
  OPERATOR_CONVERSATION_TEXT_MAX,
  type OperatorConversationEventBody,
} from "@clankie/protocol";
import type { HandleMessageStreamEvent } from "eve/client";

/**
 * Redacts a real captain Eve stream event into zero or more bounded, provider-
 * neutral operator conversation event bodies for the durable log/tail.
 *
 * This is the captain session-event sink: it copies only allow-listed scalar
 * fields (message/reasoning text, tool call id + name, input prompt/options,
 * auth/session phase), truncated to the public bounds. Raw provider payloads,
 * tool arguments/results, credentials, and continuation tokens are never
 * projected, and the registry re-validates every body against the strict public
 * schema as defense in depth.
 *
 * Streaming deltas (`message.appended`/`reasoning.appended`) and the model turn
 * envelope are intentionally not projected: the durable log carries completed
 * blocks and session lifecycle, while `turn.*` run lifecycle is owned by the
 * conversation service's accepted/completed/failed run events.
 */
export function redactEveStreamEvent(event: HandleMessageStreamEvent): OperatorConversationEventBody[] {
  switch (event.type) {
    case "message.completed": {
      const text = truncate(event.data.message ?? "", OPERATOR_CONVERSATION_TEXT_MAX);
      return text.length === 0 ? [] : [{ type: "message", role: "captain", text, streaming: false }];
    }
    case "reasoning.completed": {
      const text = truncate(event.data.reasoning, OPERATOR_CONVERSATION_TEXT_MAX);
      return text.length === 0 ? [] : [{ type: "reasoning", text, streaming: false }];
    }
    case "actions.requested": {
      return event.data.actions.map((action) => ({
        type: "tool",
        toolCallId: boundedRef(action.callId),
        name: boundedName(actionName(action as Record<string, unknown>)),
        phase: "started",
      }));
    }
    case "action.result": {
      const result = event.data.result as { callId?: unknown; toolName?: unknown; name?: unknown };
      return [
        {
          type: "tool",
          toolCallId: boundedRef(String(result.callId ?? "action")),
          name: boundedName(String(result.toolName ?? result.name ?? "action")),
          phase: event.data.status === "completed" ? "completed" : "failed",
        },
      ];
    }
    case "input.requested": {
      return event.data.requests.map((request) => {
        const options = (request.options ?? [])
          .slice(0, OPERATOR_CONVERSATION_INPUT_OPTIONS_MAX)
          .map((option) => truncate(option.label, OPERATOR_CONVERSATION_SUMMARY_MAX));
        return {
          type: "input_requested",
          requestId: boundedRef(request.requestId),
          prompt: truncate(request.prompt, OPERATOR_CONVERSATION_TEXT_MAX),
          inputKind:
            request.display === "confirmation"
              ? "approval"
              : request.display === "select"
                ? "choice"
                : "text",
          options,
        };
      });
    }
    case "authorization.required": {
      return [{ type: "auth", phase: "required", summary: boundedSummary(event.data.name) }];
    }
    case "authorization.completed": {
      return [{ type: "auth", phase: "completed" }];
    }
    case "session.started":
      return [{ type: "session", phase: "started" }];
    case "session.waiting":
      return [{ type: "session", phase: "waiting" }];
    case "session.completed":
      return [{ type: "session", phase: "completed" }];
    case "session.failed":
      return [{ type: "session", phase: "failed" }];
    default:
      return [];
  }
}

function actionName(action: Record<string, unknown>): string {
  if (typeof action.toolName === "string" && action.toolName.length > 0) return action.toolName;
  if (typeof action.name === "string" && action.name.length > 0) return action.name;
  return "action";
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function boundedName(value: string): string {
  const trimmed = value.trim();
  const bounded = trimmed.length === 0 ? "action" : trimmed.slice(0, 128);
  return bounded;
}

function boundedRef(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? "unknown" : trimmed.slice(0, 512);
}

function boundedSummary(value: string): string {
  return truncate(value, OPERATOR_CONVERSATION_SUMMARY_MAX);
}
