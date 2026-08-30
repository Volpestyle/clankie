import { describe, expect, it } from "vitest";
import {
  discordChannelName,
  encodeReactionEmoji,
  parseDiscordWebhookUrl,
  planDiscordChannelCreate,
  planDiscordGuildChannels,
  planDiscordWebhookCreate,
  planDiscordWebhookPost,
  readDiscordGuildRooms,
} from "../src/discord-rest.ts";

describe("encodeReactionEmoji", () => {
  it("encodes supported reactions and rejects malformed custom emoji", () => {
    expect(encodeReactionEmoji("👍")).toBe(encodeURIComponent("👍"));
    expect(encodeReactionEmoji("clankie:123456789012345678")).toBe("clankie:123456789012345678");
    expect(encodeReactionEmoji("<:clankie:123456789012345678>")).toBe("clankie:123456789012345678");
    expect(encodeReactionEmoji("<a:wave:99>")).toBe("wave:99");
    expect(() => encodeReactionEmoji("<:bad>")).toThrow(/discord_presence_invalid_emoji/);
    expect(() => encodeReactionEmoji("not:a:valid:emoji")).toThrow(/discord_presence_invalid_emoji/);
  });
});

describe("planDiscordWebhookPost", () => {
  const base = {
    webhookId: "123",
    webhookToken: "tok",
    username: "atlas",
    content: "it re-decodes the sheet on every mount",
  };

  it("posts as the agent, with wait so the message id comes back", () => {
    const plan = planDiscordWebhookPost({ ...base, avatarUrl: "https://example.test/atlas.png" });
    expect(plan.method).toBe("post");
    // Without wait=true a later reaction would have nothing to attach to.
    expect(plan.path).toBe("/webhooks/123/tok?wait=true");
    expect(plan.body).toMatchObject({
      username: "atlas",
      content: base.content,
      avatar_url: "https://example.test/atlas.png",
    });
  });

  it("never lets an agent's words ping the room", () => {
    const plan = planDiscordWebhookPost({ ...base, content: "@everyone ship it" });
    expect(plan.body["allowed_mentions"]).toEqual({ parse: [] });
  });

  it("targets a thread when one is given", () => {
    const plan = planDiscordWebhookPost({ ...base, threadId: "9 9" });
    expect(plan.path).toBe("/webhooks/123/tok?wait=true&thread_id=9%209");
  });

  it("rejects the usernames Discord reserves", () => {
    // Discord refuses these in any case, and a silent 400 at post time would
    // read as the agent having gone mute.
    expect(() => planDiscordWebhookPost({ ...base, username: "Discord Helper" })).toThrow(
      "discord_webhook_reserved_username",
    );
    expect(() => planDiscordWebhookPost({ ...base, username: "clyde" })).toThrow(
      "discord_webhook_reserved_username",
    );
  });

  it("rejects an unusable username or body before it reaches the wire", () => {
    expect(() => planDiscordWebhookPost({ ...base, username: "   " })).toThrow(
      "discord_webhook_invalid_username",
    );
    expect(() => planDiscordWebhookPost({ ...base, username: "a".repeat(81) })).toThrow(
      "discord_webhook_invalid_username",
    );
    expect(() => planDiscordWebhookPost({ ...base, content: "" })).toThrow("discord_webhook_invalid_content");
    expect(() => planDiscordWebhookPost({ ...base, content: "x".repeat(2001) })).toThrow(
      "discord_webhook_invalid_content",
    );
  });
});

describe("parseDiscordWebhookUrl", () => {
  it("reads the id and token out of a webhook the guild owner made", () => {
    expect(parseDiscordWebhookUrl("https://discord.com/api/webhooks/123456789/tok-EN_abc123")).toEqual({
      webhookId: "123456789",
      webhookToken: "tok-EN_abc123",
    });
    // Discord hands these out under several hosts, and with a trailing slash.
    expect(parseDiscordWebhookUrl(" https://discordapp.com/api/webhooks/1/t/ ")).toEqual({
      webhookId: "1",
      webhookToken: "t",
    });
    expect(parseDiscordWebhookUrl("https://ptb.discord.com/api/v10/webhooks/1/t")).toEqual({
      webhookId: "1",
      webhookToken: "t",
    });
  });

  it("refuses anything that is not a Discord webhook URL", () => {
    for (const url of [
      "http://discord.com/api/webhooks/1/t",
      "https://discord.com.evil.example/api/webhooks/1/t",
      "https://example.com/api/webhooks/1/t",
      "https://discord.com/api/channels/1/messages",
      "not a url",
    ]) {
      expect(() => parseDiscordWebhookUrl(url)).toThrow("discord_webhook_invalid_url");
    }
  });
});

describe("discordChannelName", () => {
  it("makes a room title into something Discord will accept as a channel name", () => {
    expect(discordChannelName("Atlas slowness")).toBe("atlas-slowness");
    expect(discordChannelName("  Release // v2  ")).toBe("release-v2");
    expect(discordChannelName("a".repeat(200))).toHaveLength(100);
  });

  it("still names the channel when the title survives to nothing", () => {
    expect(discordChannelName("!!!")).toBe("clankie-channel");
  });
});

describe("provisioning plans", () => {
  it("makes a text channel inside a guild the owner already has", () => {
    expect(planDiscordChannelCreate({ guildId: "guild-1", name: "Atlas slowness" })).toEqual({
      method: "post",
      path: "/guilds/guild-1/channels",
      // Type 0 is a guild text channel: a room for reading and typing in.
      body: { name: "atlas-slowness", type: 0 },
    });
  });

  it("makes the one webhook every member of that room posts through", () => {
    expect(planDiscordWebhookCreate({ channelId: "channel-1", name: "Atlas slowness" })).toEqual({
      method: "post",
      path: "/channels/channel-1/webhooks",
      body: { name: "Atlas slowness" },
    });
  });

  it("keeps a reserved word out of the webhook name, which Discord would refuse", () => {
    expect(planDiscordWebhookCreate({ channelId: "c", name: "discord ops" }).body).toEqual({
      name: "Clankie channel",
    });
  });

  it("offers only the guild rooms a webhook can actually post into, by name", () => {
    expect(planDiscordGuildChannels("guild-1")).toEqual({
      method: "get",
      path: "/guilds/guild-1/channels",
    });
    expect(
      readDiscordGuildRooms([
        { id: "3", name: "general", type: 0 },
        { id: "4", name: "Category", type: 4 },
        { id: "5", name: "Voice", type: 2 },
        { id: "6", name: "announcements", type: 5 },
        { id: "7", type: 0 },
      ]),
    ).toEqual([
      { channelId: "6", name: "announcements" },
      { channelId: "3", name: "general" },
    ]);
    // A guild he cannot read is an empty picker, not a thrown listing.
    expect(readDiscordGuildRooms({ message: "Missing Access" })).toEqual([]);
  });
});
