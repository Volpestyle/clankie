import { encodeReactionEmoji } from "@clankie/discord-presence-core";
import {
  isDiscordPresenceActionAvailable,
  type DiscordPresenceSessionRecord,
} from "@clankie/interactive-environment";
import {
  DiscordPresenceWriteResultSchema,
  type DiscordPresenceWrite,
  type DiscordPresenceWriteResult,
} from "@clankie/protocol";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export interface DiscordUserRestOptions {
  /** Normal-user credential, sent bare. Never logged, never returned. */
  readonly token: string;
  readonly baseUrl?: string;
  /** Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
  readonly resolveAttachment?: (artifactRef: string) => Promise<{ data: Buffer; contentType?: string }>;
  /** Injectable loopback fetch for the user-session control port. */
  readonly controlFetch?: typeof globalThis.fetch;
}

/**
 * User-session executor for the transport-agnostic presence catalog (ADR 0048).
 *
 * Deliberately implemented on `fetch` rather than `discord.js`: the bot library
 * refuses user tokens, and keeping this app free of it is what stops the two
 * planes from ever sharing a client, a gateway, or a credential.
 */
export class DiscordUserPresenceRuntime {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly resolveAttachment: DiscordUserRestOptions["resolveAttachment"];
  private readonly controlFetch: typeof globalThis.fetch;

  public constructor(options: DiscordUserRestOptions) {
    if (options.token.trim().length === 0) throw new Error("discord_user_session_token_required");
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? DISCORD_API_BASE;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.resolveAttachment = options.resolveAttachment;
    this.controlFetch = options.controlFetch ?? globalThis.fetch;
  }

  public async execute(
    write: DiscordPresenceWrite,
    session: DiscordPresenceSessionRecord,
  ): Promise<DiscordPresenceWriteResult> {
    if (write.identity.transportKind !== "user_session") {
      throw new Error("discord_presence_transport_unsupported");
    }
    if (!isDiscordPresenceActionAvailable({ action: write.action, session })) {
      throw new Error("discord_presence_action_unavailable_for_user_session");
    }

    const payload = write.payload;
    switch (payload.kind) {
      case "reply": {
        const message = await this.post(`/channels/${payload.channelId}/messages`, {
          content: payload.content,
          message_reference: { message_id: payload.messageId },
          allowed_mentions: { parse: [] },
        });
        return this.result(write, payload.channelId, messageId(message));
      }
      /** His reply carrying a picture he made this turn (ADR 0085). */
      case "reply_with_media": {
        if (this.resolveAttachment === undefined) {
          throw new Error("discord_presence_attachment_resolver_unavailable");
        }
        const file = await this.resolveAttachment(payload.artifactRef);
        const form = new FormData();
        form.append(
          "payload_json",
          JSON.stringify({
            content: payload.content,
            message_reference: { message_id: payload.messageId },
            allowed_mentions: { parse: [] },
          }),
        );
        const blob =
          file.contentType === undefined
            ? new Blob([new Uint8Array(file.data)])
            : new Blob([new Uint8Array(file.data)], { type: file.contentType });
        form.append("files[0]", blob, payload.filename);
        const message = await this.multipart(`/channels/${payload.channelId}/messages`, form);
        return this.result(write, payload.channelId, messageId(message));
      }
      case "send_message": {
        const message = await this.post(`/channels/${payload.channelId}/messages`, {
          content: payload.content,
          ...(payload.replyToMessageId === undefined
            ? {}
            : { message_reference: { message_id: payload.replyToMessageId } }),
          allowed_mentions: { parse: [] },
        });
        return this.result(write, payload.channelId, messageId(message));
      }
      case "react": {
        await this.request(
          "PUT",
          `/channels/${payload.channelId}/messages/${payload.messageId}/reactions/${encodeReactionEmoji(payload.emoji)}/@me`,
        );
        return this.result(write, payload.channelId, payload.messageId);
      }
      case "unreact": {
        await this.request(
          "DELETE",
          `/channels/${payload.channelId}/messages/${payload.messageId}/reactions/${encodeReactionEmoji(payload.emoji)}/@me`,
        );
        return this.result(write, payload.channelId, payload.messageId);
      }
      case "edit_own_message": {
        await this.request("PATCH", `/channels/${payload.channelId}/messages/${payload.messageId}`, {
          content: payload.content,
        });
        return this.result(write, payload.channelId, payload.messageId);
      }
      case "delete_own_message": {
        await this.request("DELETE", `/channels/${payload.channelId}/messages/${payload.messageId}`);
        return this.result(write, payload.channelId, payload.messageId);
      }
      case "typing_start": {
        await this.request("POST", `/channels/${payload.channelId}/typing`);
        return this.result(write, payload.channelId);
      }
      case "create_thread": {
        const path =
          payload.messageId === undefined
            ? `/channels/${payload.channelId}/threads`
            : `/channels/${payload.channelId}/messages/${payload.messageId}/threads`;
        const thread = await this.post(path, {
          name: payload.name,
          auto_archive_duration: 1_440,
          ...(payload.messageId === undefined ? { type: 11 } : {}),
        });
        return this.result(write, messageId(thread) ?? payload.channelId);
      }
      case "join_thread": {
        await this.request("PUT", `/channels/${payload.channelId}/thread-members/@me`);
        return this.result(write, payload.channelId);
      }
      case "send_attachment": {
        if (this.resolveAttachment === undefined) {
          throw new Error("discord_presence_attachment_resolver_unavailable");
        }
        const file = await this.resolveAttachment(payload.artifactRef);
        const form = new FormData();
        form.append(
          "payload_json",
          JSON.stringify({ content: payload.content ?? "", allowed_mentions: { parse: [] } }),
        );
        const blob =
          file.contentType === undefined
            ? new Blob([new Uint8Array(file.data)])
            : new Blob([new Uint8Array(file.data)], { type: file.contentType });
        form.append("files[0]", blob, payload.filename);
        const message = await this.multipart(`/channels/${payload.channelId}/messages`, form);
        return this.result(write, payload.channelId, messageId(message));
      }
      case "voice_join":
      case "voice_leave":
        // Voice membership is owned by the media session, which drives gateway
        // op 4 directly; routing it through REST would desynchronise the two.
        throw new Error("discord_presence_voice_via_media_session_only");
      case "go_live_start": {
        await postUserSessionControl(
          "/go-live/start",
          {
            guildId: payload.guildId,
            channelId: payload.channelId,
            ...("sourceUrl" in payload && typeof payload.sourceUrl === "string"
              ? { sourceUrl: payload.sourceUrl }
              : {}),
          },
          this.controlFetch,
        );
        return this.result(write, payload.channelId);
      }
      case "go_live_stop": {
        await postUserSessionControl("/go-live/stop", { guildId: payload.guildId }, this.controlFetch);
        return this.result(write);
      }
      case "activity_start":
      case "activity_stop":
        // Embedded applications belong to the bot application (ADR 0047).
        throw new Error("discord_presence_activity_requires_bot");
      default: {
        const _exhaustive: never = payload;
        throw new Error(`discord_presence_unknown_payload:${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  private result(
    write: DiscordPresenceWrite,
    channelId?: string,
    resultMessageId?: string,
  ): DiscordPresenceWriteResult {
    return DiscordPresenceWriteResultSchema.parse({
      id: write.idempotencyKey,
      action: write.action,
      transportKind: "user_session",
      ...(channelId === undefined ? {} : { channelId }),
      ...(resultMessageId === undefined ? {} : { messageId: resultMessageId }),
    });
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, body);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        // A user token is presented bare; `Bot ` would make Discord reject it.
        authorization: this.token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return this.readResponse(response, method, path);
  }

  private async multipart(path: string, form: FormData): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: this.token },
      body: form,
    });
    return this.readResponse(response, "POST", path);
  }

  private async readResponse(response: Response, method: string, path: string): Promise<unknown> {
    if (!response.ok) {
      // Status and route only: a Discord error body can echo message content.
      throw new Error(`discord_user_session_rest_failed:${String(response.status)}:${method}:${path}`);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
}

function messageId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

async function postUserSessionControl(
  path: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const port = process.env.CLANKIE_USER_SESSION_CONTROL_PORT?.trim() || "4312";
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `discord_presence_go_live_media_unavailable:user_session_control_${String(response.status)}`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("discord_presence_go_live_media_unavailable")) {
      throw error;
    }
    throw new Error("discord_presence_go_live_media_unavailable");
  }
}

export { encodeReactionEmoji } from "@clankie/discord-presence-core";
