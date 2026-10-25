import { stripVTControlCharacters } from "node:util";
import { redactSensitiveText, sanitizeForSupportBundle } from "@clankie/observability";
import type { OperatorCurrentActivity } from "@clankie/protocol/presence";
import type { OperatorConversationStreamEvent } from "@clankie/protocol";
import type { ConversationMeta } from "./types.ts";

function safeText(text: string): string {
  return redactSensitiveText(stripVTControlCharacters(text)).trim().slice(0, 32768);
}

/** The event's actual tool identity, including the fleet bridge's structured operation. */
function toolActivity(event: Extract<OperatorConversationStreamEvent, { type: "tool" }>) {
  let operation = event.name;
  let detail = event.detail ?? event.summary ?? "";
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
      detail = JSON.stringify(sanitizeForSupportBundle(parsed), null, 2);
    }
  } catch {
    /* A native tool may supply a plain-text summary, already bounded by its event. */
  }
  const source: OperatorCurrentActivity["source"] = /(?:^|__)linear_/u.test(operation)
    ? "issue"
    : /(?:^|__)discord_/u.test(operation)
      ? "discord"
      : /(?:^|__|\.)(?:exec|exec_command|apply_patch|read|write|edit|bash|shell)$/u.test(operation)
        ? "coding"
        : "chat";
  // Only a typed tool's explicit issue identity becomes an issue route. Never scan prose for keys.
  const key = source === "issue" ? (args?.issueId ?? args?.id ?? args?.issue) : undefined;
  return {
    source,
    text: safeText(`${operation}${detail ? `\n${detail}` : ""}`),
    ...(typeof key === "string" && /^[A-Z][A-Z0-9]*-\d+$/u.test(key) ? { key } : {}),
  };
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
        source: tool.source,
        text: tool.text,
        target: tool.key ? { kind: "issue", key: tool.key } : { kind: "conversation", conversationId },
      };
    } else if (event.type === "message" && !event.streaming && (event.role === "captain" || event.spoken)) {
      if (event.spoken && voice?.conversationId !== conversationId) {
        this.entries.delete(conversationId);
        return;
      }
      const text = safeText(event.text);
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
