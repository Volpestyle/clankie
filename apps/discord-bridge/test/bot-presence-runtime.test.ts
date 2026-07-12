import type { DiscordPresenceWrite } from "@clankie/protocol";
import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordBotPresenceRuntime, encodeReactionEmoji } from "../src/bot-presence-runtime.ts";

describe("DiscordBotPresenceRuntime", () => {
  it("posts replies and reactions through the bot REST client", async () => {
    const post = vi.fn(async () => ({ id: "msg-out-1" }));
    const put = vi.fn(async () => undefined);
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post, put, delete: vi.fn(), patch: vi.fn() } as never,
    });

    const reply = await runtime.execute(
      write({
        action: "discord.presence.reply",
        content: "hi",
        payload: { kind: "reply", channelId: "ch-1", messageId: "msg-1", content: "hi" },
      }),
    );
    expect(reply).toMatchObject({
      action: "discord.presence.reply",
      transportKind: "bot",
      messageId: "msg-out-1",
    });
    expect(post).toHaveBeenCalledOnce();

    await runtime.execute(
      write({
        action: "discord.presence.react",
        payload: { kind: "react", channelId: "ch-1", messageId: "msg-1", emoji: "👍" },
      }),
    );
    expect(put).toHaveBeenCalledOnce();
  });

  it("starts a public thread without messageId using type PublicThread", async () => {
    const post = vi.fn(async () => ({ id: "thread-1" }));
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post, put: vi.fn(), delete: vi.fn(), patch: vi.fn() } as never,
    });
    await runtime.execute(
      write({
        action: "discord.presence.create_thread",
        payload: { kind: "create_thread", channelId: "ch-1", name: "mission-thread" },
      }),
    );
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("ch-1"),
      expect.objectContaining({
        body: expect.objectContaining({
          name: "mission-thread",
          type: ChannelType.PublicThread,
        }),
      }),
    );
  });

  it("sends attachments via rest files[] without passThroughBody casts", async () => {
    const post = vi.fn(async () => ({ id: "msg-attach" }));
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post, put: vi.fn(), delete: vi.fn(), patch: vi.fn() } as never,
      resolveAttachment: async () => ({ data: Buffer.from("png"), contentType: "image/png" }),
    });
    // send_attachment is publish-external (policy) but the executor still accepts a
    // policy-allowed write; attachment resolver proves the REST shape.
    await expect(
      runtime.execute(
        write({
          action: "discord.presence.send_attachment",
          payload: {
            kind: "send_attachment",
            channelId: "ch-1",
            artifactRef: "artifact:1",
            filename: "shot.png",
          },
        }),
      ),
    ).resolves.toMatchObject({ messageId: "msg-attach" });
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        files: [expect.objectContaining({ name: "shot.png", contentType: "image/png" })],
      }),
    );
    expect(JSON.stringify(post.mock.calls)).not.toContain("passThroughBody");
  });

  it("rejects Go Live on bot transport under pinned present phase", async () => {
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() } as never,
    });
    await expect(
      runtime.execute(
        write({
          action: "discord.presence.go_live_start",
          payload: { kind: "go_live_start", guildId: "g1", channelId: "v1" },
        }),
      ),
    ).rejects.toThrow(/discord_presence_action_unavailable_for_bot/);
  });

  it("refuses construction without a bot token", () => {
    expect(() => new DiscordBotPresenceRuntime({ botToken: "  " })).toThrow(
      /discord_presence_bot_token_required/,
    );
  });
});

describe("encodeReactionEmoji", () => {
  it("encodes unicode, custom name:id, and angle-bracket mentions", () => {
    expect(encodeReactionEmoji("👍")).toBe(encodeURIComponent("👍"));
    expect(encodeReactionEmoji("clankie:123456789012345678")).toBe("clankie:123456789012345678");
    expect(encodeReactionEmoji("<:clankie:123456789012345678>")).toBe("clankie:123456789012345678");
    expect(encodeReactionEmoji("<a:wave:99>")).toBe("wave:99");
  });

  it("rejects malformed colon-bearing strings", () => {
    expect(() => encodeReactionEmoji("<:bad>")).toThrow(/discord_presence_invalid_emoji/);
    expect(() => encodeReactionEmoji("not:a:valid:emoji")).toThrow(/discord_presence_invalid_emoji/);
  });
});

function write(
  partial: Pick<DiscordPresenceWrite, "action" | "payload"> &
    Partial<Pick<DiscordPresenceWrite, "content">>,
): DiscordPresenceWrite {
  return {
    schemaVersion: 1,
    idempotencyKey: `id-${partial.action}`,
    identity: {
      missionId: "mission-1",
      correlationId: "corr-1",
      profileHash: "profile-1",
      characterId: "clankie",
      credentialRef: "broker:discord_bot:lab",
      transportKind: "bot",
    },
    ...partial,
  };
}
