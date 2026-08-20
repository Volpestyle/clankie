import type { DiscordPresenceActionRequest } from "@clankie/protocol";

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
