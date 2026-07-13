import type { OperatorConversationRecovery, OperatorConversationStreamEvent } from "@clankie/protocol";
import type { OperatorConversationEventSink } from "./operator-conversations.ts";

export interface OperatorConversationRenderTarget {
  insertMarkdown(markdown: string): unknown;
  refreshStatus(label: string): void;
}

/** Renders only the strict public event union; no transport/provider payload is accepted. */
export function renderOperatorConversationEvent(event: OperatorConversationStreamEvent): string {
  switch (event.type) {
    case "message":
      return `**${event.role === "operator" ? "Operator" : "Captain"}**\n\n${event.text}`;
    case "reasoning":
      return `**Reasoning**\n\n${event.text}`;
    case "tool":
      return `**Tool ${event.phase}**\n\n${event.name}${event.summary === undefined ? "" : ` · ${event.summary}`}`;
    case "input_requested":
      return `**Input requested**\n\n${event.prompt}${
        event.options.length === 0 ? "" : `\n\n${event.options.map((option) => `- ${option}`).join("\n")}`
      }`;
    case "input_resolved":
      return `**Input ${event.outcome}**\n\nRequest ${event.requestId}`;
    case "auth":
      return `**Authorization ${event.phase}**${event.summary === undefined ? "" : `\n\n${event.summary}`}`;
    case "session":
      return `**Captain session**\n\n${event.phase}`;
    case "turn":
      return `**Captain turn**\n\n${event.phase}${event.reasonCode === undefined ? "" : ` · ${event.reasonCode}`}`;
    case "worker_transcript":
      return `**Worker ${event.phase}**\n\n${event.summary}`;
    case "unsupported":
      return `**Unsupported captain event**\n\n${event.kind} · ${event.summary}`;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function renderOperatorConversationRecovery(recovery: OperatorConversationRecovery): string {
  return `**Conversation recovery required**\n\n${recovery.code}. Streaming stopped before crossing the reset boundary.`;
}

export function createOperatorConversationShellSink(
  shell: OperatorConversationRenderTarget,
): OperatorConversationEventSink {
  return {
    event(event): void {
      shell.insertMarkdown(renderOperatorConversationEvent(event));
      if (event.type === "turn") shell.refreshStatus(`conversation turn ${event.phase}`);
    },
    recovery(recovery): void {
      shell.insertMarkdown(renderOperatorConversationRecovery(recovery));
      shell.refreshStatus("conversation recovery required");
    },
  };
}
