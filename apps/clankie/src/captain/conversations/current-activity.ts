import { stripVTControlCharacters } from "node:util";
import { redactSensitiveText } from "@clankie/observability";
import type { OperatorCurrentActivity } from "@clankie/protocol/presence";
import type { OperatorConversationStreamEvent } from "@clankie/protocol";
import type { ConversationMeta } from "./types.ts";

export function safeCurrentActivityText(text: string): string {
  return redactSensitiveText(stripVTControlCharacters(text)).trim().slice(0, 32768);
}

/** The event's actual tool identity, including the fleet bridge's structured operation. */
function toolActivity(event: Extract<OperatorConversationStreamEvent, { type: "tool" }>) {
  let operation = event.name;
  const detail = event.detail ?? event.summary ?? "";
  let args: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const object = parsed as Record<string, unknown>;
      if (typeof object.name === "string" && /(?:^|__)clankie_call$/u.test(event.name)) {
        operation = object.name;
        if (object.arguments !== null && typeof object.arguments === "object")
          args = object.arguments as Record<string, unknown>;
      } else args = object;
    }
  } catch {
    /* Unstructured summaries are not a safe source of activity text. */
  }
  const name = operation.toLowerCase();
  const source: OperatorCurrentActivity["source"] = /(?:^|__)linear_/u.test(name)
    ? "issue"
    : /(?:^|__)discord_/u.test(name)
      ? "discord"
      : /(?:^|__|\.)(?:exec|exec_command|apply_patch|read|write|edit|bash|shell)$/u.test(name)
        ? "coding"
        : "chat";
  // Only a typed tool's explicit issue identity becomes an issue route. Never scan prose for keys.
  const key = source === "issue" ? (args?.issueId ?? args?.id ?? args?.issue) : undefined;
  const issueKey = typeof key === "string" && /^[A-Z][A-Z0-9]*-\d+$/u.test(key) ? key : undefined;
  // Only explicitly human descriptions may become text. Never serialize arguments,
  // interpolate a tool name, or fall back to an unstructured native summary.
  const description = [args?.description, args?.taskTitle]
    .filter((value): value is string => typeof value === "string")
    .map((value) => safeCurrentActivityText(value).replace(/\s+/gu, " ").slice(0, 160))
    .find(Boolean);
  const label =
    source === "issue"
      ? issueKey
        ? `Updating ${issueKey}`
        : "Working with issues"
      : /(?:^|__|\.)(?:message_peer|message_clankie|send_message|followup_task)$/u.test(name)
        ? "Messaging a worker"
        : /(?:^|__|\.)(?:hire|hire_worker)$/u.test(name)
          ? "Hiring a worker"
          : source === "coding"
            ? "Running a check"
            : source === "discord"
              ? "Checking Discord"
              : "Working";
  return { source, text: description || label, ...(issueKey ? { key: issueKey } : {}) };
}

/** Volatile event projection. No disk reads, transcript scans, timers or model calls on presence reads. */
export class CurrentActivities {
  private readonly entries = new Map<
    string,
    { activity: OperatorCurrentActivity; toolCallId?: string; callIncarnation?: string }
  >();

  public clear(conversationId: string): void {
    this.entries.delete(conversationId);
  }

  public observe(
    meta: ConversationMeta,
    event: OperatorConversationStreamEvent,
    live: boolean,
    voice?: { conversationId: string; incarnation: string },
  ): void {
    // Matches desktop notices: no mixed-room, channel, worker, side-fork or replayed content.
    if (
      !live ||
      meta.parentConversationId !== undefined ||
      !["global", "workspace"].includes(meta.scope.kind)
    )
      return;
    const age = Date.now() - Date.parse(event.occurredAt);
    if (!Number.isFinite(age) || age < 0 || age > 30000) return;
    const conversationId = meta.conversationId;
    if (
      event.type === "turn" ||
      (event.type === "activity" && event.phase === "waiting") ||
      (event.type === "message" && event.role === "operator" && !event.spoken)
    ) {
      this.entries.delete(conversationId);
      return;
    }
    if (event.type === "tool" && event.phase !== "started") {
      if (this.entries.get(conversationId)?.toolCallId === event.toolCallId)
        this.entries.delete(conversationId);
      return;
    }
    let activity: OperatorCurrentActivity;
    if (event.type === "tool") {
      const tool = toolActivity(event);
      activity = {
        id: `${conversationId}:${event.cursor}`,
        kind: "tool",
        source: tool.source,
        text: tool.text,
        target: tool.key ? { kind: "issue", key: tool.key } : { kind: "conversation", conversationId },
      };
    } else if (event.type === "message" && !event.streaming && (event.role === "captain" || event.spoken)) {
      if (event.spoken && voice?.conversationId !== conversationId) {
        this.entries.delete(conversationId);
        return;
      }
      const text = safeCurrentActivityText(event.text);
      if (!text) return;
      activity = {
        id: `${conversationId}:${event.cursor}`,
        source: event.spoken ? "call" : "chat",
        text,
        target: { kind: "conversation", conversationId, entryId: event.cursor },
      };
    } else return;
    this.entries.delete(conversationId);
    this.entries.set(conversationId, {
      activity,
      ...(event.type === "tool" ? { toolCallId: event.toolCallId } : {}),
      ...(event.type === "message" && event.spoken && voice ? { callIncarnation: voice.incarnation } : {}),
    });
    if (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
  }

  public current(
    active: (conversationId: string, callIncarnation?: string) => boolean,
  ): OperatorCurrentActivity | undefined {
    let latest: OperatorCurrentActivity | undefined;
    for (const [id, entry] of this.entries) {
      if (!active(id, entry.callIncarnation)) this.entries.delete(id);
      else latest = entry.activity;
    }
    return latest;
  }
}
