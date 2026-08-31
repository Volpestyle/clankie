import { discordPresenceLaneAddress } from "@clankie/interactive-environment";
import {
  DiscordCaptainActionInputSchema,
  DiscordCaptainActionResultSchema,
  DiscordPresenceWriteSchema,
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

export type CaptainDiscordActionAdmission =
  | { kind: "refuse"; result: DiscordCaptainActionResult }
  | { kind: "watch"; guildId: string }
  | { kind: "plan"; guildId: string; channelId: string; plan: CaptainDiscordActionPlan };

/**
 * Shared DM / progress-card / allowlist gate. Watch start/stop stay body-local
 * because the official bot posts an activity launch and the lab body goes live.
 */
export function admitCaptainDiscordAction(input: {
  action: DiscordCaptainActionInput;
  admittedGuildIds: ReadonlySet<string>;
  admittedChannelIds: ReadonlySet<string>;
  ownsProgressMessage: (id: string) => boolean;
}): CaptainDiscordActionAdmission {
  if (input.action.action === "typing") {
    // Each body lights its own in-flight delivery before admission — there is
    // no channel to authorize, only a delivery it already holds.
    return {
      kind: "refuse",
      result: { ok: false, message: "Typing belongs to the body holding that delivery." },
    };
  }
  if (input.action.guildId === undefined) {
    return { kind: "refuse", result: { ok: false, message: "That Discord action is not available in DMs." } };
  }
  const { guildId } = input.action;
  const plan = planNonWatchCaptainDiscordAction(input.action);
  if (plan === undefined) return { kind: "watch", guildId };
  if (
    input.action.action === "tool_progress" &&
    input.action.progressMessageId !== undefined &&
    !input.ownsProgressMessage(input.action.progressMessageId)
  ) {
    return {
      kind: "refuse",
      result: { ok: false, message: "That tool activity card does not belong to this process." },
    };
  }
  if (
    !input.admittedGuildIds.has(guildId) ||
    (input.admittedChannelIds.size > 0 && !input.admittedChannelIds.has(input.action.channelId))
  ) {
    return {
      kind: "refuse",
      result: {
        ok: false,
        message:
          input.action.action === "react" || input.action.action === "unreact"
            ? "That message is outside my admitted Discord channels."
            : input.action.action === "send_text_update" || input.action.action === "tool_progress"
              ? "That channel is outside my admitted Discord channels."
              : "Threads only work in my admitted server channels.",
      },
    };
  }
  return { kind: "plan", guildId, channelId: input.action.channelId, plan };
}

export async function executePlannedCaptainDiscordAction(input: {
  call: DiscordCaptainActionInput;
  plan: CaptainDiscordActionPlan;
  guildId: string;
  channelId: string;
  characterId: string;
  credentialRef: string;
  transportKind: "bot" | "user_session";
  presencePort: {
    getHealth(): Promise<{ profileHash: string }>;
    executeDiscordPresenceAction(write: DiscordPresenceWrite): Promise<{ messageId?: string | undefined }>;
  };
  progressMessageIds: Set<string>;
}): Promise<DiscordCaptainActionResult> {
  const health = await input.presencePort.getHealth();
  const action = await input.presencePort.executeDiscordPresenceAction(
    DiscordPresenceWriteSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `captain:${input.call.callId}:${input.call.action}`,
      action: input.plan.action,
      identity: {
        presenceSessionId: discordPresenceLaneAddress({ guildId: input.guildId, channelId: input.channelId }),
        correlationId: `discord-captain-action:${input.call.callId}`,
        profileHash: health.profileHash,
        characterId: input.characterId,
        credentialRef: input.credentialRef,
        transportKind: input.transportKind,
      },
      payload: input.plan.payload,
    }),
  );
  if (input.call.action === "tool_progress") {
    if (action.messageId !== undefined) input.progressMessageIds.add(action.messageId);
    if (input.call.phase !== "running" && input.call.progressMessageId !== undefined) {
      input.progressMessageIds.delete(input.call.progressMessageId);
    }
  }
  return {
    ok: true,
    message: input.plan.successMessage,
    ...(action.messageId === undefined ? {} : { messageId: action.messageId }),
  };
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
    // Not a presence write: the bodies intercept it before admission.
    case "typing":
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
