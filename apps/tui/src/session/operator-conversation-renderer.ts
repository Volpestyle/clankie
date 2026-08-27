import type {
  OperatorConversationContextUsage,
  OperatorConversationRecovery,
  OperatorConversationStreamEvent,
} from "@clankie/protocol";
import type { OperatorConversationEventSink } from "./operator-conversations.ts";

/**
 * Structural subset of the face shell's transcript block options, kept local so
 * the session layer stays decoupled from face internals.
 */
export interface OperatorConversationBlockOptions {
  readonly clickToggle: boolean;
  readonly collapsed: boolean;
}

interface OperatorConversationBlockHandle {
  setMarkdown(markdown: string): void;
}

export interface OperatorConversationRenderTarget {
  insertMarkdown(
    markdown: string,
    options?: OperatorConversationBlockOptions,
  ): OperatorConversationBlockHandle;
  refreshStatus(label: string): void;
  setTurnLoaderMessage?(message: string): void;
}

// A body at or under this length fits on one or two wrapped transcript rows at
// typical terminal widths; collapsing it would hide the whole payload behind a
// "hidden lines" stub, so only longer bodies start collapsed.
const COLLAPSE_BODY_CHARS = 160;

/**
 * Detail-heavy machinery blocks (tool activity, reasoning, worker transcript
 * tails) toggle open/closed on click. They start collapsed only when the body
 * actually hides detail — multi-line or longer than a couple of wrapped rows —
 * so short entries stay readable in place. Conversation content (You/Clankie
 * messages, input and auth prompts, failures) always renders expanded.
 */
export function operatorConversationBlockOptions(
  event: OperatorConversationStreamEvent,
  markdown: string,
): OperatorConversationBlockOptions | undefined {
  if (event.type === "tool" && event.skillName !== undefined) return undefined;
  if (event.type !== "tool" && event.type !== "reasoning" && event.type !== "worker_transcript") {
    return undefined;
  }
  const body = markdown.slice(markdown.indexOf("\n\n") + 2);
  return { clickToggle: true, collapsed: body.includes("\n") || body.length > COLLAPSE_BODY_CHARS };
}

/**
 * Renders only the strict public event union; no transport/provider payload is
 * accepted. Returns `undefined` for events that belong on the status line, not
 * in the transcript: the durable log carries the full lifecycle so every
 * surface can replay and derive state, but the transcript shows only the
 * conversation itself plus failures. Operator messages render as "You" — the
 * log's `operator` role is always the operator's own half of the conversation,
 * whichever surface it was typed on.
 */
export function renderOperatorConversationEvent(event: OperatorConversationStreamEvent): string | undefined {
  switch (event.type) {
    case "activity":
      return undefined;
    case "message":
      return `**${event.role === "operator" ? "You" : "Clankie"}**\n\n${event.text}`;
    case "reasoning":
      return `**Reasoning**\n\n${event.text}`;
    case "context":
      return undefined;
    case "tool": {
      if (event.skillName !== undefined) {
        if (event.phase === "started") return undefined;
        return `**Skill: ${event.skillName} - ${event.phase === "completed" ? "loaded" : "failed to load"}**`;
      }
      return renderToolEvent(event);
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
      // the operator needs to see.
      return event.phase === "failed" || event.phase === "cancelled"
        ? `**Clankie turn**\n\n${event.phase}${event.reasonCode === undefined ? "" : ` · ${event.reasonCode}`}`
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
   * The prompt text this surface just echoed locally as "You". The durable log
   * replays the operator's own message back on the tail; the first operator
   * message matching this text is suppressed so the transcript shows it once.
   * Later operator messages — another surface talking in the same conversation,
   * or a repeated identical prompt — still render.
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
  const activeTools = new Map<
    string,
    { readonly argumentsDetail?: string; readonly block: OperatorConversationBlockHandle }
  >();
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
      if (
        event.type === "message" &&
        event.role === "operator" &&
        pendingEcho !== undefined &&
        event.text === pendingEcho
      ) {
        pendingEcho = undefined;
      } else if (event.type === "tool" && event.skillName === undefined) {
        if (event.phase === "started") {
          const markdown = renderToolEvent(event);
          const block = shell.insertMarkdown(markdown, operatorConversationBlockOptions(event, markdown));
          activeTools.set(event.toolCallId, {
            ...(event.detail === undefined ? {} : { argumentsDetail: event.detail }),
            block,
          });
        } else {
          const activeTool = activeTools.get(event.toolCallId);
          activeTools.delete(event.toolCallId);
          const markdown = renderToolEvent(event, activeTool?.argumentsDetail);
          if (activeTool === undefined) {
            shell.insertMarkdown(markdown, operatorConversationBlockOptions(event, markdown));
          } else {
            activeTool.block.setMarkdown(markdown);
          }
        }
      } else {
        const markdown = renderOperatorConversationEvent(event);
        if (markdown !== undefined) {
          shell.insertMarkdown(markdown, operatorConversationBlockOptions(event, markdown));
        }
      }
      if (event.type === "turn") shell.refreshStatus(`conversation turn ${event.phase}`);
      if (event.type === "context") options.onContextUsage?.(event.usage);
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

type OperatorConversationToolEvent = Extract<OperatorConversationStreamEvent, { readonly type: "tool" }>;

function renderToolEvent(event: OperatorConversationToolEvent, argumentsDetail?: string): string {
  const summary = event.summary === undefined ? "" : event.summary;
  const argumentsBlock =
    event.phase !== "started" && argumentsDetail !== undefined
      ? `Arguments:\n\n\`\`\`json\n${argumentsDetail}\n\`\`\``
      : "";
  const detail =
    event.detail === undefined
      ? ""
      : `${event.phase === "started" ? "Arguments" : "Result"}:\n\n\`\`\`${event.phase === "started" ? "json" : ""}\n${event.detail}\n\`\`\``;
  const body = [summary, argumentsBlock, detail].filter((part) => part.length > 0).join("\n\n");
  return `**Tool: ${event.name} - ${event.phase}**${body.length === 0 ? "" : `\n\n${body}`}`;
}
