import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitCaptainDiscordAction,
  executePlannedCaptainDiscordAction,
  planNonWatchCaptainDiscordAction,
  tryHandleCaptainDiscordActionRequest,
} from "../src/captain-action-control.ts";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

describe("captain Discord action control", () => {
  it("shares non-watch mapping and leaves watch destinations to each body", () => {
    const context = {
      callId: "call-1",
      actorId: "user-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
    };
    expect(planNonWatchCaptainDiscordAction({ ...context, action: "react", emoji: "👍" })).toMatchObject({
      action: "discord.presence.react",
      payload: { kind: "react", emoji: "👍" },
      successMessage: "I reacted.",
    });
    expect(
      planNonWatchCaptainDiscordAction({
        ...context,
        action: "tool_progress",
        phase: "running",
        categories: ["browsing"],
        toolCalls: 1,
        activeToolCalls: 1,
        failedToolCalls: 0,
        elapsedSeconds: 2,
      }),
    ).toMatchObject({
      action: "discord.presence.tool_progress",
      payload: { kind: "tool_progress", replyToMessageId: "message-1", categories: ["browsing"] },
    });
    expect(planNonWatchCaptainDiscordAction({ ...context, action: "watch_start" })).toBeUndefined();
  });

  it("admits planned actions on the allowlist and leaves watch to the body", () => {
    const react = {
      action: "react" as const,
      callId: "call-1",
      actorId: "user-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      emoji: "👍",
    };
    expect(
      admitCaptainDiscordAction({
        action: { ...react, guildId: undefined },
        admittedGuildIds: new Set(["guild-1"]),
        admittedChannelIds: new Set(),
        ownsProgressMessage: () => true,
      }),
    ).toEqual({
      kind: "refuse",
      result: { ok: false, message: "That Discord action is not available in DMs." },
    });
    expect(
      admitCaptainDiscordAction({
        action: react,
        admittedGuildIds: new Set(["other"]),
        admittedChannelIds: new Set(),
        ownsProgressMessage: () => true,
      }).kind,
    ).toBe("refuse");
    expect(
      admitCaptainDiscordAction({
        action: {
          action: "watch_start",
          callId: "call-1",
          actorId: "user-1",
          guildId: "guild-1",
          channelId: "channel-1",
          messageId: "message-1",
        },
        admittedGuildIds: new Set(["guild-1"]),
        admittedChannelIds: new Set(),
        ownsProgressMessage: () => true,
      }),
    ).toEqual({ kind: "watch", guildId: "guild-1" });
    expect(
      admitCaptainDiscordAction({
        action: react,
        admittedGuildIds: new Set(["guild-1"]),
        admittedChannelIds: new Set(),
        ownsProgressMessage: () => true,
      }).kind,
    ).toBe("plan");
  });

  it("executes a planned action through the presence port", async () => {
    const progressMessageIds = new Set<string>();
    const result = await executePlannedCaptainDiscordAction({
      call: {
        action: "react",
        callId: "call-1",
        actorId: "user-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        emoji: "👍",
      },
      plan: {
        action: "discord.presence.react",
        payload: { kind: "react", channelId: "channel-1", messageId: "message-1", emoji: "👍" },
        successMessage: "I reacted.",
      },
      guildId: "guild-1",
      channelId: "channel-1",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      presencePort: {
        getHealth: async () => ({ profileHash: "profile-1" }),
        executeDiscordPresenceAction: async () => ({ messageId: "posted-1" }),
      },
      progressMessageIds,
    });
    expect(result).toEqual({ ok: true, message: "I reacted.", messageId: "posted-1" });
  });

  it("validates host-stamped context before execution", async () => {
    const calls: unknown[] = [];
    const server = createServer((request, response) => {
      if (
        tryHandleCaptainDiscordActionRequest(request, response, (input) => {
          calls.push(input);
          return Promise.resolve({ ok: true, message: "Reacted." });
        })
      ) {
        return;
      }
      response.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server unavailable");
    const url = `http://127.0.0.1:${String(address.port)}/captain-action`;

    const valid = await fetch(url, {
      method: "POST",
      body: JSON.stringify({
        action: "react",
        callId: "call-1",
        actorId: "user-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        emoji: "👍",
      }),
    });
    const invalid = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ action: "react", emoji: "👍", channelId: "model-picked" }),
    });

    expect(valid.status).toBe(200);
    expect(calls).toEqual([
      expect.objectContaining({ actorId: "user-1", channelId: "channel-1", messageId: "message-1" }),
    ]);
    expect(invalid.status).toBe(400);
  });
});
