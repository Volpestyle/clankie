import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DISCORD_BODY_PERMISSIONS_PATH,
  DISCORD_BODY_TEST_POST_PATH,
  DiscordPermissionsRequestSchema,
  DiscordBodyTestPostRequestSchema,
  DiscordSetupTestPostResultSchema,
  DiscordPermissionsSnapshotSchema,
  DISCORD_SETUP_TEST_TEXT,
  type DiscordPermissionsRequest,
  type DiscordPermissionsSnapshot,
  type DiscordBodyTestPostRequest,
} from "@clankie/protocol";

/** The gateway owning the account supplies its own authorization. No retry after dispatch. */
export async function postDiscordSetupTestMessage(
  query: DiscordBodyTestPostRequest,
  options: {
    authorization: string;
    baseUrl?: string;
  },
): Promise<string> {
  const response = await fetch(
    `${options.baseUrl ?? "https://discord.com/api/v10"}/channels/${query.channelId}/messages`,
    {
      method: "POST",
      headers: { authorization: options.authorization, "content-type": "application/json" },
      body: JSON.stringify({ content: DISCORD_SETUP_TEST_TEXT, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error("discord_test_post_receipt_unavailable");
  const message: unknown = await response.json();
  if (
    message === null ||
    typeof message !== "object" ||
    !("id" in message) ||
    typeof message.id !== "string" ||
    !/^\d{5,32}$/u.test(message.id)
  )
    throw new Error("discord_test_post_receipt_unavailable");
  return message.id;
}

/** Separate read and explicit write routes on the body's existing authenticated loopback port. */
export function tryHandleDiscordSetupRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    token: string;
    read(query: DiscordPermissionsRequest): DiscordPermissionsSnapshot;
    post(query: DiscordBodyTestPostRequest): Promise<string>;
  },
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (![DISCORD_BODY_PERMISSIONS_PATH, DISCORD_BODY_TEST_POST_PATH].includes(url.pathname)) return false;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  const reply = (status: number, value: unknown) => {
    response.writeHead(status);
    response.end(JSON.stringify(value));
  };
  const expected = Buffer.from(`Bearer ${options.token}`);
  const received = Buffer.from(request.headers.authorization ?? "");
  if (!options.token || expected.length !== received.length || !timingSafeEqual(expected, received)) {
    reply(403, { error: "discord_setup_authentication_required" });
    return true;
  }
  const write = url.pathname === DISCORD_BODY_TEST_POST_PATH;
  if (request.method !== (write ? "POST" : "GET")) {
    reply(405, { error: "method_not_allowed" });
    return true;
  }
  if (!write) {
    const query = DiscordPermissionsRequestSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) reply(400, { error: "invalid_discord_permissions_request" });
    else {
      try {
        reply(200, DiscordPermissionsSnapshotSchema.parse(options.read(query.data)));
      } catch {
        reply(503, { error: "discord_setup_unavailable" });
      }
    }
    return true;
  }
  void (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4096) {
        reply(413, { error: "request_too_large" });
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      reply(400, { error: "invalid_discord_test_post" });
      return;
    }
    const parsed = DiscordBodyTestPostRequestSchema.safeParse(data);
    if (!parsed.success) {
      reply(400, { error: "invalid_discord_test_post" });
      return;
    }
    const query = parsed.data;
    if (response.destroyed || request.aborted) return;
    const snapshot = options.read({ guildId: query.guildId, channelId: query.channelId });
    if (snapshot.actorId !== query.actorId) {
      reply(200, { outcome: "unavailable", reason: "account_changed" });
      return;
    }
    if (snapshot.permissions.send_messages !== "passed") {
      reply(200, { outcome: "unavailable", reason: "permissions_not_verified" });
      return;
    }
    // Exactly one dispatch. A missing native receipt is not evidence that the post failed.
    try {
      const messageId = await options.post(query);
      reply(
        200,
        DiscordSetupTestPostResultSchema.parse({
          outcome: "posted",
          body: snapshot.body,
          guildId: query.guildId,
          channelId: query.channelId,
          messageId,
        }),
      );
    } catch {
      reply(200, { outcome: "unconfirmed", reason: "post_receipt_unavailable" });
    }
  })().catch(() => {
    if (!response.writableEnded) reply(503, { error: "discord_setup_unavailable" });
  });
  return true;
}
