import type {
  OperatorConversationContextUsage,
  OperatorConversationRecovery,
  OperatorConversationStreamEvent,
} from "@clankie/protocol";
import type { OperatorConversationEventSink } from "./operator-conversations.ts";

/**
 * Structural subset of the face shell's transcript surface, kept local so the
 * session layer stays decoupled from face internals. Conversation content maps
 * onto typed blocks (user box, assistant markdown, reasoning, tool
 * executions); everything else renders as a markdown notice.
 */
export interface OperatorConversationRenderTarget {
  insertUserMessage(text: string): void;
  insertAssistantMarkdown(text: string): void;
  /** Draw the message being typed; the settled message lands in the same block. */
  updateLiveAssistant(text: string): void;
  /** Stop treating the open block as a draft, leaving what he typed on screen. */
  clearLiveAssistant(): void;
  insertReasoning(text: string): void;
  beginToolCall(toolCallId: string, name: string, argumentsDetail?: string): void;
  completeToolCall(
    toolCallId: string,
    name: string,
    outcome: { readonly failed: boolean; readonly detail?: string | undefined },
  ): void;
  insertMarkdown(markdown: string): unknown;
  refreshStatus(label: string): void;
  setTurnLoaderMessage?(message: string): void;
}

/**
 * Renders the notice-shaped subset of the strict public event union as
 * markdown; conversation content (messages, reasoning, tool executions) maps
 * onto typed transcript blocks instead, and `undefined` means the event
 * belongs on the status line, not in the transcript: the durable log carries
 * the full lifecycle so every surface can replay and derive state, but the
 * transcript shows only the conversation itself plus failures.
 */
export function renderOperatorConversationNotice(event: OperatorConversationStreamEvent): string | undefined {
  switch (event.type) {
    case "activity":
    case "message":
    case "reasoning":
    case "context":
    // A reaction is an acknowledgement, not a turn. It belongs beside the entry
    // it points at, which this transcript has no way to draw, and a notice per
    // toggle would be noisier than the thing it reports.
    case "reaction":
      return undefined;
    case "tool": {
      if (event.skillName === undefined || event.phase === "started") return undefined;
      return `**Skill: ${event.skillName} - ${event.phase === "completed" ? "loaded" : "failed to load"}**`;
    }
    case "input_requested":
      return `**Input requested**\n\n${event.prompt}${
        event.options.length === 0 ? "" : `\n\n${event.options.map((option) => `- ${option}`).join("\n")}`
      }`;
    case "input_resolved":
      return `**Input ${event.outcome}**\n\nRequest ${event.requestId}`;
    case "auth":
      return `**Authorization ${event.phase}**${event.summary === undefined ? "" : `\n\n${event.summary}`}`;
    case "session":
      // started/waiting/completed are healthy lifecycle plumbing; only a
      // failure is worth a transcript block.
      return event.phase === "failed" ? `**Clankie session**\n\n${event.phase}` : undefined;
    case "turn":
      // accepted/completed drive the status line; failures carry a reasonCode
      // and the message the operator needs to see.
      return event.phase === "failed" || event.phase === "cancelled"
        ? `**Clankie turn**\n\n${event.phase}${event.reasonCode === undefined ? "" : ` · ${event.reasonCode}`}${
            event.summary === undefined ? "" : `\n\n${event.summary}`
          }`
        : undefined;
    case "worker_transcript":
      return `**Worker ${event.phase}**\n\n${event.summary}`;
    case "unsupported":
      return `**Unsupported Clankie event**\n\n${event.kind} · ${event.summary}`;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function renderOperatorConversationRecovery(recovery: OperatorConversationRecovery): string {
  return recovery.recoverable
    ? `**Conversation history resumed**\n\n${recovery.code}. Older unavailable events were skipped at the retained boundary.`
    : `**Conversation recovery required**\n\n${recovery.code}. This conversation is no longer available.`;
}

export interface OperatorConversationShellSinkOptions {
  /**
   * The prompt text this surface just echoed locally as the operator's own
   * message. The durable log replays the operator's own message back on the
   * tail; the first operator message matching this text is suppressed so the
   * transcript shows it once. Later operator messages — another surface
   * talking in the same conversation, or a repeated identical prompt — still
   * render.
   */
  readonly localEchoText?: string;
  readonly onContextUsage?: (usage: OperatorConversationContextUsage) => void;
}

export function createOperatorConversationShellSink(
  shell: OperatorConversationRenderTarget,
  options: OperatorConversationShellSinkOptions = {},
): OperatorConversationEventSink {
  // The registry stores the trimmed submitted message, so compare trimmed.
  let pendingEcho = options.localEchoText?.trim();
  const activeToolMessages = new Map<string, string>();
  return {
    event(event): void {
      if (event.type === "activity" && activeToolMessages.size === 0) {
        shell.setTurnLoaderMessage?.(activityLoaderMessage(event.phase));
      } else if (event.type === "tool") {
        if (event.phase === "started") {
          activeToolMessages.set(
            event.toolCallId,
            event.skillName === undefined ? `Running ${event.name}...` : `Loading ${event.skillName}...`,
          );
        } else {
          activeToolMessages.delete(event.toolCallId);
        }
        shell.setTurnLoaderMessage?.([...activeToolMessages.values()].at(-1) ?? "Waiting for response...");
      } else if (event.type === "turn" && event.phase === "accepted") {
        shell.setTurnLoaderMessage?.("Waiting for response...");
      }
      if (event.type === "message") {
        if (event.role === "operator") {
          if (pendingEcho !== undefined && event.text === pendingEcho) pendingEcho = undefined;
          else shell.insertUserMessage(event.text);
        } else {
          shell.insertAssistantMarkdown(event.text);
        }
      } else if (event.type === "reasoning") {
        shell.insertReasoning(event.text);
      } else if (event.type === "tool" && event.skillName === undefined) {
        if (event.phase === "started") {
          shell.beginToolCall(event.toolCallId, event.name, event.detail);
        } else {
          shell.completeToolCall(event.toolCallId, event.name, {
            detail: event.detail ?? event.summary,
            failed: event.phase === "failed",
          });
        }
      } else {
        const markdown = renderOperatorConversationNotice(event);
        if (markdown !== undefined) shell.insertMarkdown(markdown);
      }
      if (event.type === "turn") {
        // A turn that ends without settling its draft (failed, cancelled) keeps
        // the words on screen but must stop owning the block, or the next
        // message would be typed into the middle of the last one.
        if (event.phase !== "accepted") shell.clearLiveAssistant();
        shell.refreshStatus(`conversation turn ${event.phase}`);
      }
      if (event.type === "context") options.onContextUsage?.(event.usage);
    },
    live(draft): void {
      if (draft === undefined) {
        shell.clearLiveAssistant();
        return;
      }
      shell.updateLiveAssistant(draft.text);
      // He is visibly answering; the spinner has nothing left to say.
      shell.setTurnLoaderMessage?.("Responding...");
    },
    recovery(recovery): void {
      shell.insertMarkdown(renderOperatorConversationRecovery(recovery));
      shell.refreshStatus(
        recovery.recoverable ? "conversation history resumed" : "conversation recovery required",
      );
    },
  };
}

function activityLoaderMessage(
  phase: Extract<OperatorConversationStreamEvent, { readonly type: "activity" }>["phase"],
): string {
  switch (phase) {
    case "waiting":
      return "Waiting for response...";
    case "thinking":
      return "Thinking...";
    case "responding":
      return "Responding...";
    case "preparing_tool":
      return "Preparing tool call...";
    case "compacting":
      return "Compacting...";
    case "retrying":
      return "Retrying...";
  }
}
