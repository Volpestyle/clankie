import { isDiscordPresenceActionAvailable } from "@clankie/interactive-environment";
import {
  DiscordPresenceWriteResultSchema,
  type DiscordPresenceWrite,
  type DiscordPresenceWriteResult,
} from "@clankie/protocol";
import { ChannelType, REST, Routes } from "discord.js";

export interface DiscordBotPresenceRuntimeOptions {
  /** Official bot token only. Never a user token. */
  botToken: string;
  /** Injectable REST for fixtures; defaults to a live discord.js REST client. */
  rest?: REST;
  /** Optional artifact resolver for send_attachment (bytes stay outside the control plane). */
  resolveAttachment?: (artifactRef: string) => Promise<{ data: Buffer; contentType?: string }>;
}

/**
 * P1 bot-transport executor for the transport-agnostic presence catalog (ADR 0024).
 * Go Live and user-session paths are rejected here; they require P2/P3 runtimes.
 */
export class DiscordBotPresenceRuntime {
  private readonly rest: REST;
  private readonly resolveAttachment:
    | ((artifactRef: string) => Promise<{ data: Buffer; contentType?: string }>)
    | undefined;

  public constructor(options: DiscordBotPresenceRuntimeOptions) {
    if (!options.botToken.trim()) {
      throw new Error("discord_presence_bot_token_required");
    }
    this.rest = options.rest ?? new REST({ version: "10" }).setToken(options.botToken);
    this.resolveAttachment = options.resolveAttachment;
  }

  public async execute(write: DiscordPresenceWrite): Promise<DiscordPresenceWriteResult> {
    if (write.identity.transportKind !== "bot") {
      throw new Error("discord_presence_transport_unsupported");
    }
    // P1: no real presence session state. Pin phase to `present` so the catalog
    // gate is not self-fulfilled from the payload kind (voice/go_live would
    // fabricate voice_active/go_live_active). P2+ must pass phase from the
    // durable presence session projection.
    const phase = "present" as const;
    if (
      !isDiscordPresenceActionAvailable({
        action: write.action,
        phase,
        transportKind: "bot",
      })
    ) {
      throw new Error("discord_presence_action_unavailable_for_bot");
    }

    const payload = write.payload;
    switch (payload.kind) {
      case "reply": {
        const message = (await this.rest.post(Routes.channelMessages(payload.channelId), {
          body: {
            content: payload.content,
            message_reference: { message_id: payload.messageId },
            allowed_mentions: { parse: [] },
          },
        })) as { id?: string };
        return result(write, payload.channelId, message.id);
      }
      case "send_message": {
        const message = (await this.rest.post(Routes.channelMessages(payload.channelId), {
          body: {
            content: payload.content,
            ...(payload.replyToMessageId === undefined
              ? {}
              : { message_reference: { message_id: payload.replyToMessageId } }),
            allowed_mentions: { parse: [] },
          },
        })) as { id?: string };
        return result(write, payload.channelId, message.id);
      }
      case "react": {
        await this.rest.put(
          Routes.channelMessageOwnReaction(
            payload.channelId,
            payload.messageId,
            encodeReactionEmoji(payload.emoji),
          ),
        );
        return result(write, payload.channelId, payload.messageId);
      }
      case "unreact": {
        await this.rest.delete(
          Routes.channelMessageOwnReaction(
            payload.channelId,
            payload.messageId,
            encodeReactionEmoji(payload.emoji),
          ),
        );
        return result(write, payload.channelId, payload.messageId);
      }
      case "edit_own_message": {
        await this.rest.patch(Routes.channelMessage(payload.channelId, payload.messageId), {
          body: { content: payload.content },
        });
        return result(write, payload.channelId, payload.messageId);
      }
      case "delete_own_message": {
        await this.rest.delete(Routes.channelMessage(payload.channelId, payload.messageId));
        return result(write, payload.channelId, payload.messageId);
      }
      case "typing_start": {
        await this.rest.post(Routes.channelTyping(payload.channelId));
        return result(write, payload.channelId);
      }
      case "create_thread": {
        if (payload.messageId === undefined) {
          // API v10 start-thread-without-message requires an explicit channel type.
          const thread = (await this.rest.post(Routes.threads(payload.channelId), {
            body: {
              name: payload.name,
              auto_archive_duration: 1_440,
              type: ChannelType.PublicThread,
            },
          })) as { id?: string };
          return result(write, thread.id ?? payload.channelId);
        }
        const thread = (await this.rest.post(Routes.threads(payload.channelId, payload.messageId), {
          body: { name: payload.name, auto_archive_duration: 1_440 },
        })) as { id?: string };
        return result(write, thread.id ?? payload.channelId);
      }
      case "join_thread": {
        await this.rest.put(Routes.threadMembers(payload.channelId, "@me"));
        return result(write, payload.channelId);
      }
      case "send_attachment": {
        if (this.resolveAttachment === undefined) {
          throw new Error("discord_presence_attachment_resolver_unavailable");
        }
        const file = await this.resolveAttachment(payload.artifactRef);
        const message = (await this.rest.post(Routes.channelMessages(payload.channelId), {
          body: {
            content: payload.content ?? "",
            allowed_mentions: { parse: [] },
          },
          files: [
            {
              name: payload.filename,
              data: file.data,
              ...(file.contentType === undefined ? {} : { contentType: file.contentType }),
            },
          ],
        })) as { id?: string };
        return result(write, payload.channelId, message.id);
      }
      case "voice_join":
      case "voice_leave":
        throw new Error("discord_presence_voice_via_clankvox_only");
      case "go_live_start":
      case "go_live_stop":
        throw new Error("discord_presence_go_live_requires_user_session");
      default: {
        const _exhaustive: never = payload;
        throw new Error(`discord_presence_unknown_payload:${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}

function result(
  write: DiscordPresenceWrite,
  channelId?: string,
  messageId?: string,
): DiscordPresenceWriteResult {
  return DiscordPresenceWriteResultSchema.parse({
    id: write.idempotencyKey,
    action: write.action,
    transportKind: "bot",
    ...(channelId === undefined ? {} : { channelId }),
    ...(messageId === undefined ? {} : { messageId }),
  });
}

/** Encode a reaction for the Discord REST path (unicode or name:id custom). */
export function encodeReactionEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  // <:name:id> or <a:name:id>
  const mentioned = trimmed.match(/^<a?:([a-zA-Z0-9_]{2,32}):(\d+)>$/);
  if (mentioned) return `${mentioned[1]}:${mentioned[2]}`;
  // Already name:id
  if (/^[a-zA-Z0-9_]{2,32}:\d+$/.test(trimmed)) return trimmed;
  if (trimmed.includes(":")) {
    throw new Error("discord_presence_invalid_emoji");
  }
  return encodeURIComponent(trimmed);
}

export function createDiscordBotPresenceRuntime(
  options: DiscordBotPresenceRuntimeOptions,
): { execute: DiscordBotPresenceRuntime["execute"] } {
  const runtime = new DiscordBotPresenceRuntime(options);
  return {
    execute: (write) => runtime.execute(write),
  };
}
