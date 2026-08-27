import type { DiscordPresenceActionRequest, DiscordToolProgressCategory } from "@clankie/protocol";

type DiscordToolProgressPayload = Extract<DiscordPresenceActionRequest, { readonly kind: "tool_progress" }>;

const TOOL_PROGRESS_LABELS: Readonly<Record<DiscordToolProgressCategory, string>> = {
  browsing: "Browsing",
  creating_media: "Creating media",
  working_locally: "Working locally",
  using_connected_services: "Using connected services",
  playing: "Playing",
  using_tools: "Using tools",
};

const TOOL_PROGRESS_PHASE = {
  running: { accentColor: 0xf0b232, icon: "🛠️", title: "Tool activity" },
  completed: { accentColor: 0x3ba55d, icon: "✅", title: "Tool activity complete" },
  failed: { accentColor: 0xed4245, icon: "⚠️", title: "Tool activity stopped" },
} as const;

function toolProgressMarkdown(payload: DiscordToolProgressPayload): string {
  if (payload.phase === "dismissed") throw new Error("Dismissed tool progress has no visible content");
  const phase = TOOL_PROGRESS_PHASE[payload.phase];
  const calls = `${String(payload.toolCalls)} tool call${payload.toolCalls === 1 ? "" : "s"}`;
  const active =
    payload.phase === "running" && payload.activeToolCalls > 0
      ? `${String(payload.activeToolCalls)} active`
      : undefined;
  const failed = payload.failedToolCalls > 0 ? `${String(payload.failedToolCalls)} failed` : undefined;
  const elapsed =
    payload.elapsedSeconds < 60
      ? `${String(payload.elapsedSeconds)}s`
      : `${String(Math.floor(payload.elapsedSeconds / 60))}m ${String(payload.elapsedSeconds % 60)}s`;
  return [
    `${phase.icon} **${phase.title}**`,
    payload.categories.map((category) => TOOL_PROGRESS_LABELS[category]).join(" · "),
    [calls, active, failed, elapsed].filter((part) => part !== undefined).join(" · "),
  ].join("\n");
}

/** Components V2 payload for the official bot body. */
export function discordToolProgressComponents(
  payload: DiscordToolProgressPayload,
): readonly Record<string, unknown>[] {
  if (payload.phase === "dismissed") throw new Error("Dismissed tool progress has no visible content");
  return [
    {
      type: 17,
      accent_color: TOOL_PROGRESS_PHASE[payload.phase].accentColor,
      components: [{ type: 10, content: toolProgressMarkdown(payload) }],
    },
  ];
}

/** Plain Discord formatting for the personal-lab user-session fallback. */
export function discordToolProgressText(payload: DiscordToolProgressPayload): string {
  return toolProgressMarkdown(payload)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Encode a reaction for the Discord REST path (unicode or name:id custom). */
export function encodeReactionEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  const mentioned = /^<a?:([a-zA-Z0-9_]{2,32}):(\d+)>$/u.exec(trimmed);
  if (mentioned) return `${mentioned[1]}:${mentioned[2]}`;
  if (/^[a-zA-Z0-9_]{2,32}:\d+$/u.test(trimmed)) return trimmed;
  if (trimmed.includes(":")) throw new Error("discord_presence_invalid_emoji");
  return encodeURIComponent(trimmed);
}

export interface DiscordRestActionPlan {
  readonly method: "delete" | "patch" | "post" | "put";
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly channelId: string;
  readonly messageId?: string;
  readonly responseId?: "channelId" | "messageId";
}

/** HTTP shape shared by bot and user-session REST; media and live surfaces stay body-local. */
export function planDiscordRestAction(
  payload: DiscordPresenceActionRequest,
): DiscordRestActionPlan | undefined {
  const messages = "channelId" in payload ? `/channels/${payload.channelId}/messages` : "";
  switch (payload.kind) {
    case "reply":
      return {
        method: "post",
        path: messages,
        body: {
          content: payload.content,
          message_reference: { message_id: payload.messageId },
          allowed_mentions: { parse: [] },
        },
        channelId: payload.channelId,
        responseId: "messageId",
      };
    case "send_message":
      return {
        method: "post",
        path: messages,
        body: {
          content: payload.content,
          ...(payload.replyToMessageId === undefined
            ? {}
            : { message_reference: { message_id: payload.replyToMessageId } }),
          allowed_mentions: { parse: [] },
        },
        channelId: payload.channelId,
        responseId: "messageId",
      };
    case "react":
    case "unreact":
      return {
        method: payload.kind === "react" ? "put" : "delete",
        path: `${messages}/${payload.messageId}/reactions/${encodeReactionEmoji(payload.emoji)}/@me`,
        channelId: payload.channelId,
        messageId: payload.messageId,
      };
    case "edit_own_message":
      return {
        method: "patch",
        path: `${messages}/${payload.messageId}`,
        body: { content: payload.content },
        channelId: payload.channelId,
        messageId: payload.messageId,
      };
    case "delete_own_message":
      return {
        method: "delete",
        path: `${messages}/${payload.messageId}`,
        channelId: payload.channelId,
        messageId: payload.messageId,
      };
    case "typing_start":
      return { method: "post", path: `/channels/${payload.channelId}/typing`, channelId: payload.channelId };
    case "create_thread":
      return {
        method: "post",
        path:
          payload.messageId === undefined
            ? `/channels/${payload.channelId}/threads`
            : `${messages}/${payload.messageId}/threads`,
        body: {
          name: payload.name,
          auto_archive_duration: 1_440,
          ...(payload.messageId === undefined ? { type: 11 } : {}),
        },
        channelId: payload.channelId,
        responseId: "channelId",
      };
    case "join_thread":
      return {
        method: "put",
        path: `/channels/${payload.channelId}/thread-members/@me`,
        channelId: payload.channelId,
      };
    default:
      return undefined;
  }
}

export function resolveDiscordRestActionResult(
  plan: DiscordRestActionPlan,
  response: unknown,
): { channelId: string; messageId?: string } {
  const id =
    response !== null && typeof response === "object" && typeof (response as { id?: unknown }).id === "string"
      ? (response as { id: string }).id
      : undefined;
  const messageId = plan.responseId === "messageId" ? id : plan.messageId;
  return {
    channelId: plan.responseId === "channelId" ? (id ?? plan.channelId) : plan.channelId,
    ...(messageId === undefined ? {} : { messageId }),
  };
}
