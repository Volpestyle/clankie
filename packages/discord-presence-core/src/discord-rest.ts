import type {
  DiscordGuildRoom,
  DiscordPresenceActionRequest,
  DiscordToolProgressCategory,
} from "@clankie/protocol";

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

/**
 * One agent posting into a Clankie channel projected onto a guild
 * (ADR 0146). A webhook renders each agent as itself — its own name and its
 * own pixel face — from a single per-channel credential, so no seat needs a bot
 * application or, worse, a user account: ADR 0048 already treats one automated
 * user account as an accepted ToS risk, and a fleet's worth is a fleet's worth
 * of violations.
 */
export interface DiscordWebhookPersonaPost {
  readonly webhookId: string;
  readonly webhookToken: string;
  readonly username: string;
  readonly content: string;
  readonly avatarUrl?: string;
  /** Post into a thread on the webhook's channel rather than the channel. */
  readonly threadId?: string;
}

export interface DiscordWebhookPostPlan {
  readonly method: "post";
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/** Discord rejects a webhook username containing either of these, in any case. */
const FORBIDDEN_WEBHOOK_NAME = /discord|clyde/iu;
const WEBHOOK_USERNAME_MAX = 80;
const WEBHOOK_CONTENT_MAX = 2000;

/**
 * Plan the REST call for one persona post. Pure, like
 * {@link planDiscordRestAction} — the transport stays in the caller.
 *
 * `wait=true` is not optional: the response carries the message id, and without
 * it a later reaction has nothing to attach to.
 */
export function planDiscordWebhookPost(post: DiscordWebhookPersonaPost): DiscordWebhookPostPlan {
  const username = post.username.trim();
  if (username.length === 0 || username.length > WEBHOOK_USERNAME_MAX) {
    throw new Error("discord_webhook_invalid_username");
  }
  if (FORBIDDEN_WEBHOOK_NAME.test(username)) throw new Error("discord_webhook_reserved_username");
  const content = post.content.trim();
  if (content.length === 0 || content.length > WEBHOOK_CONTENT_MAX) {
    throw new Error("discord_webhook_invalid_content");
  }
  let avatarUrl: string | undefined;
  if (post.avatarUrl !== undefined) {
    try {
      const parsed = new URL(post.avatarUrl);
      if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0)
        throw new Error();
      avatarUrl = parsed.toString();
    } catch {
      throw new Error("discord_webhook_invalid_avatar_url");
    }
  }
  const query =
    post.threadId === undefined ? "?wait=true" : `?wait=true&thread_id=${encodeURIComponent(post.threadId)}`;
  return {
    method: "post",
    path: `/webhooks/${post.webhookId}/${post.webhookToken}${query}`,
    body: {
      username,
      content,
      ...(avatarUrl === undefined ? {} : { avatar_url: avatarUrl }),
      // An agent's words must never be able to ping a room. Same rule the bot
      // send path already holds.
      allowed_mentions: { parse: [] },
    },
  };
}

export interface DiscordWebhookCredential {
  readonly webhookId: string;
  readonly webhookToken: string;
}

/**
 * Read the id and token out of a webhook URL the guild owner created
 * (ADR 0146). Taking the credential the owner already made is what keeps a
 * projection free of any per-agent registration: one webhook renders every
 * member as itself, and the bot's own grant — which is scoped to channels that
 * already exist (ADR 0133) — is not involved at all.
 *
 * The token half is a bearer credential in a URL. It stays on the host: the
 * operator boundary carries `webhookId` and never this.
 */
export function parseDiscordWebhookUrl(url: string): DiscordWebhookCredential {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error("discord_webhook_invalid_url");
  }
  if (parsed.protocol !== "https:" || !/^(?:\w+\.)*discord(?:app)?\.com$/u.test(parsed.hostname)) {
    throw new Error("discord_webhook_invalid_url");
  }
  const match = /\/webhooks\/(\d{1,32})\/([\w-]{1,120})\/?$/u.exec(parsed.pathname);
  if (match === null) throw new Error("discord_webhook_invalid_url");
  return { webhookId: match[1]!, webhookToken: match[2]! };
}

/**
 * Discord channel names are lowercased and space-free, so a room title becomes
 * a slug rather than being rejected. Anything that survives is what a person
 * would recognise as the same room.
 */
export function discordChannelName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .replaceAll(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 100);
  // A title of nothing but punctuation still has to name a channel.
  return slug.length === 0 ? "clankie-channel" : slug;
}

export interface DiscordProvisionPlan {
  readonly method: "post";
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/**
 * Make the guild channel a Clankie channel is projected into (ADR 0146). This
 * is provisioning inside a guild the owner already has, which is the whole of
 * what Clankie does to a server — never guild creation.
 */
export function planDiscordChannelCreate(input: {
  readonly guildId: string;
  readonly name: string;
  readonly topic?: string;
}): DiscordProvisionPlan {
  return {
    method: "post",
    path: `/guilds/${input.guildId}/channels`,
    body: {
      name: discordChannelName(input.name),
      // 0 is a guild text channel; the room is for reading and typing in.
      type: 0,
      ...(input.topic === undefined ? {} : { topic: input.topic.slice(0, 1024) }),
    },
  };
}

/** Make the one forum post that carries a projected Clankie room. */
export function planDiscordForumPostCreate(input: {
  readonly forumId: string;
  readonly name: string;
}): DiscordProvisionPlan {
  return {
    method: "post",
    path: `/channels/${input.forumId}/threads`,
    body: {
      name: input.name.trim().slice(0, 100),
      message: {
        content: "This post mirrors a Clankie room.",
        allowed_mentions: { parse: [] },
      },
    },
  };
}

/** The one per-channel credential every member of the room posts through. */
export function planDiscordWebhookCreate(input: {
  readonly channelId: string;
  readonly name: string;
}): DiscordProvisionPlan {
  return {
    method: "post",
    path: `/channels/${input.channelId}/webhooks`,
    // Webhook names carry the same reserved-word rule as the per-post username.
    body: { name: FORBIDDEN_WEBHOOK_NAME.test(input.name) ? "Clankie channel" : input.name.slice(0, 80) },
  };
}

/**
 * Containers a projection can use: a guild text or announcement channel
 * directly, or one new post under a forum.
 */
const DIRECT_CHANNEL_TYPES = new Set([0, 5]);
const FORUM_CHANNEL_TYPE = 15;
const REQUIRE_TAG_CHANNEL_FLAG = 1 << 4;

/**
 * The rooms in a guild a channel could be projected onto (ADR 0146). Projection
 * is not limited to rooms Clankie made: he makes the webhook on any channel in
 * the home guild, which is what saves the owner a trip through Server Settings
 * to copy a URL out.
 */
export function planDiscordGuildChannels(guildId: string): { readonly method: "get"; readonly path: string } {
  return { method: "get", path: `/guilds/${guildId}/channels` };
}

/** Guild channels narrowed to the ones a webhook can post into, named for a picker. */
export function readDiscordGuildRooms(raw: unknown): readonly DiscordGuildRoom[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((channel): channel is { id: string; name: string; type: number; flags?: number } => {
      const record = channel as { id?: unknown; name?: unknown; type?: unknown; flags?: unknown };
      return (
        typeof record.id === "string" &&
        typeof record.name === "string" &&
        typeof record.type === "number" &&
        (DIRECT_CHANNEL_TYPES.has(record.type) ||
          (record.type === FORUM_CHANNEL_TYPE &&
            !(typeof record.flags === "number" && (record.flags & REQUIRE_TAG_CHANNEL_FLAG) !== 0)))
      );
    })
    .map((channel) => ({
      kind: channel.type === FORUM_CHANNEL_TYPE ? ("forum" as const) : ("channel" as const),
      channelId: channel.id,
      name: channel.name.slice(0, 100),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
