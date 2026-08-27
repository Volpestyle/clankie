import {
  DiscordCaptainActionInputSchema,
  DiscordCaptainActionResultSchema,
  type DiscordCaptainActionInput,
  type DiscordCaptainActionResult,
  type DiscordPresenceWrite,
} from "@clankie/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface CaptainDiscordActionPlan {
  readonly action: DiscordPresenceWrite["action"];
  readonly payload: DiscordPresenceWrite["payload"];
  readonly successMessage: string;
}

/** Shared text/reaction/thread mapping; each body keeps watch authority and destination local. */
export function planNonWatchCaptainDiscordAction(
  input: DiscordCaptainActionInput,
): CaptainDiscordActionPlan | undefined {
  const { action, channelId, messageId } = input;
  switch (action) {
    case "react":
    case "unreact":
      return {
        action: `discord.presence.${action}`,
        payload: { kind: action, channelId, messageId, emoji: input.emoji },
        successMessage: action === "react" ? "I reacted." : "I removed my reaction.",
      };
    case "send_text_update":
      return {
        action: "discord.presence.send_message",
        payload: { kind: "send_message", channelId, replyToMessageId: messageId, content: input.text },
        successMessage:
          "I posted that text update. Keep working; your final text reply still posts when the turn ends.",
      };
    case "tool_progress":
      return {
        action: "discord.presence.tool_progress",
        payload: {
          kind: "tool_progress",
          channelId,
          replyToMessageId: messageId,
          ...(input.progressMessageId === undefined ? {} : { messageId: input.progressMessageId }),
          phase: input.phase,
          categories: input.categories,
          toolCalls: input.toolCalls,
          activeToolCalls: input.activeToolCalls,
          failedToolCalls: input.failedToolCalls,
          elapsedSeconds: input.elapsedSeconds,
        },
        successMessage: "I updated the tool activity card.",
      };
    case "create_thread":
      return {
        action: "discord.presence.create_thread",
        payload: { kind: "create_thread", channelId, messageId, name: input.name },
        successMessage: "I started the thread.",
      };
    case "join_thread":
      return {
        action: "discord.presence.join_thread",
        payload: { kind: "join_thread", channelId },
        successMessage: "I joined the thread.",
      };
    case "watch_start":
    case "watch_stop":
      return undefined;
  }
}

/** Loopback `/captain-action` shared by both Discord bodies. */
export function tryHandleCaptainDiscordActionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  execute: (input: DiscordCaptainActionInput) => Promise<DiscordCaptainActionResult>,
): boolean {
  if (request.method !== "POST" || (request.url ?? "/").split("?")[0] !== "/captain-action") {
    return false;
  }
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    void (async () => {
      try {
        const input = DiscordCaptainActionInputSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        );
        const result = DiscordCaptainActionResultSchema.parse(await execute(input));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, message: "Invalid Discord action request." }));
      }
    })();
  });
  return true;
}
