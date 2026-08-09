import {
  isDiscordPresenceActionAvailable,
  type DiscordPresenceSessionRecord,
} from "@clankie/interactive-environment";
import {
  DiscordPresenceWriteResultSchema,
  type DiscordActivitySurface,
  type DiscordPresenceWrite,
  type DiscordPresenceWriteResult,
} from "@clankie/protocol";
import { ChannelType, REST, Routes } from "discord.js";

/** Discord invite target type for launching an embedded application (activity). */
const INVITE_TARGET_TYPE_EMBEDDED_APPLICATION = 2;

/** The subset of the invite object this executor reads back. */
interface ChannelInvite {
  code?: string;
  target_type?: number;
  target_application?: { id?: string };
}
/** Activity invites are short-lived; a stale link must not keep a surface launchable. */
const ACTIVITY_INVITE_MAX_AGE_SECONDS = 6 * 60 * 60;

export interface DiscordBotPresenceRuntimeOptions {
  /** Official bot token only. Never a user token. */
  botToken: string;
  /** Injectable REST for fixtures; defaults to a live discord.js REST client. */
  rest?: REST;
  /** Optional artifact resolver for send_attachment (bytes stay outside the control plane). */
  resolveAttachment?: (artifactRef: string) => Promise<{ data: Buffer; contentType?: string }>;
  /**
   * Deny-by-default surface → embedded application id map (ADR 0047). A surface
   * absent from this map cannot be launched, so a model can never name an
   * arbitrary Discord application to open in a channel.
   */
  activityApplicationIds?: Readonly<Partial<Record<DiscordActivitySurface, string>>>;
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
  private readonly activityApplicationIds: Readonly<Partial<Record<DiscordActivitySurface, string>>>;

  public constructor(options: DiscordBotPresenceRuntimeOptions) {
    if (!options.botToken.trim()) {
      throw new Error("discord_presence_bot_token_required");
    }
    this.rest = options.rest ?? new REST({ version: "10" }).setToken(options.botToken);
    this.resolveAttachment = options.resolveAttachment;
    this.activityApplicationIds = options.activityApplicationIds ?? {};
  }

  public async execute(
    write: DiscordPresenceWrite,
    session: DiscordPresenceSessionRecord,
  ): Promise<DiscordPresenceWriteResult> {
    if (write.identity.transportKind !== "bot") {
      throw new Error("discord_presence_transport_unsupported");
    }
    if (!isDiscordPresenceActionAvailable({ action: write.action, session })) {
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
      /**
       * His reply with a picture he made on the same turn (ADR 0085). One
       * message, not a reply followed by an attachment: two posts would read as
       * two utterances, and the second could land without the first.
       *
       * The resolver is the same one `send_attachment` uses — same containment
       * check, same hash verification. What differs is upstream: the schema
       * only admits a generated-media reference here, so this path cannot post
       * an arbitrary artifact without an approval.
       */
      case "reply_with_media": {
        if (this.resolveAttachment === undefined) {
          throw new Error("discord_presence_attachment_resolver_unavailable");
        }
        const file = await this.resolveAttachment(payload.artifactRef);
        const message = (await this.rest.post(Routes.channelMessages(payload.channelId), {
          body: {
            content: payload.content,
            message_reference: { message_id: payload.messageId },
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
      case "activity_start": {
        const applicationId = this.activityApplicationIds[payload.surface];
        if (applicationId === undefined) {
          throw new Error("discord_presence_activity_surface_not_configured");
        }
        const invite = (await this.rest.post(Routes.channelInvites(payload.channelId), {
          body: {
            max_age: ACTIVITY_INVITE_MAX_AGE_SECONDS,
            max_uses: 0,
            temporary: false,
            unique: true,
            target_type: INVITE_TARGET_TYPE_EMBEDDED_APPLICATION,
            target_application_id: applicationId,
          },
        })) as { code?: string };
        if (invite.code === undefined || invite.code.length === 0) {
          throw new Error("discord_presence_activity_invite_missing_code");
        }
        // Replace rather than accumulate: prior launch links stop working.
        await this.revokeActivityInvites(payload.channelId, invite.code);
        const message = (await this.rest.post(Routes.channelMessages(payload.channelId), {
          body: {
            content: `Launch: https://discord.gg/${invite.code}`,
            allowed_mentions: { parse: [] },
          },
        })) as { id?: string };
        return result(write, payload.channelId, message.id);
      }
      case "activity_stop": {
        await this.revokeActivityInvites(payload.channelId);
        return result(write, payload.channelId);
      }
      default: {
        const _exhaustive: never = payload;
        throw new Error(`discord_presence_unknown_payload:${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * Revoke this channel's activity invites for surfaces we configure, optionally
   * sparing a code we just minted.
   *
   * Deliberately stateless: the presence runtime is constructed per action, so
   * an in-process invite map would not survive between start and stop, and
   * would forget everything on restart. Reading live invites is also the only
   * view that stays correct if a link was created by a previous process.
   *
   * Stopping is best-effort by design — Discord cannot evict viewers already
   * inside an activity instance, so stop means "no further launches" and the
   * frame stream is what actually goes dark.
   */
  private async revokeActivityInvites(channelId: string, keepCode?: string): Promise<void> {
    const configured = new Set(Object.values(this.activityApplicationIds));
    if (configured.size === 0) return;
    let invites: ChannelInvite[];
    try {
      invites = (await this.rest.get(Routes.channelInvites(channelId))) as ChannelInvite[];
    } catch {
      // Losing the ability to list invites must not fail the stop.
      return;
    }
    if (!Array.isArray(invites)) return;
    for (const invite of invites) {
      if (invite.target_type !== INVITE_TARGET_TYPE_EMBEDDED_APPLICATION) continue;
      if (invite.target_application?.id === undefined) continue;
      if (!configured.has(invite.target_application.id)) continue;
      if (invite.code === undefined || invite.code === keepCode) continue;
      try {
        await this.rest.delete(Routes.invite(invite.code));
      } catch {
        // An already-expired or already-deleted invite is a successful stop.
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

export function createDiscordBotPresenceRuntime(options: DiscordBotPresenceRuntimeOptions): {
  execute: DiscordBotPresenceRuntime["execute"];
} {
  const runtime = new DiscordBotPresenceRuntime(options);
  return {
    execute: (write, session) => runtime.execute(write, session),
  };
}
