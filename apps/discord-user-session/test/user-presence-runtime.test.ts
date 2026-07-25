import { DiscordPresenceSessionRecordSchema } from "@clankie/interactive-environment";
import type { DiscordPresenceWrite } from "@clankie/protocol";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DiscordUserPresenceRuntime, encodeReactionEmoji } from "../src/user-presence-runtime.ts";

describe("DiscordUserPresenceRuntime", () => {
  it("sends the user credential bare, without the bot prefix", async () => {
    const fetchImpl = jsonFetch({ id: "message-out-1" });
    const result = await runtime(fetchImpl).execute(
      write({
        action: "discord.presence.reply",
        payload: { kind: "reply", channelId: "channel-1", messageId: "message-1", content: "hi" },
      }),
      present,
    );

    expect(result).toMatchObject({ transportKind: "user_session", messageId: "message-out-1" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/channels/channel-1/messages");
    const headers = init.headers as Record<string, string>;
    // Discord rejects a user token presented as `Bot <token>`.
    expect(headers.authorization).toBe("user-token");
    expect(headers.authorization?.startsWith("Bot ")).toBe(false);
  });

  it("suppresses mentions on every outbound message", async () => {
    const fetchImpl = jsonFetch({ id: "message-out-2" });
    await runtime(fetchImpl).execute(
      write({
        action: "discord.presence.send_message",
        payload: { kind: "send_message", channelId: "channel-1", content: "hello" },
      }),
      present,
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ allowed_mentions: { parse: [] } });
  });

  it("refuses a write addressed to the bot transport", async () => {
    const botWrite = write({
      action: "discord.presence.reply",
      payload: { kind: "reply", channelId: "channel-1", messageId: "message-1", content: "hi" },
    });
    await expect(
      runtime(jsonFetch({})).execute(
        { ...botWrite, identity: { ...botWrite.identity, transportKind: "bot" } },
        present,
      ),
    ).rejects.toThrow(/discord_presence_transport_unsupported/u);
  });

  it("refuses embedded activities, which belong to the bot application", async () => {
    const voiceSession = DiscordPresenceSessionRecordSchema.parse({
      ...present,
      phase: "voice_active",
      voiceGuildIds: ["guild-1"],
    });
    await expect(
      runtime(jsonFetch({})).execute(
        write({
          action: "discord.presence.activity_start",
          payload: {
            kind: "activity_start",
            guildId: "guild-1",
            channelId: "voice-1",
            surface: "gba_emulator",
          },
        }),
        voiceSession,
      ),
    ).rejects.toThrow(/discord_presence_action_unavailable_for_user_session/u);
  });

  it("fails loudly rather than reporting a Go Live nobody can watch", async () => {
    const goLiveSession = DiscordPresenceSessionRecordSchema.parse({
      ...present,
      phase: "voice_active",
      voiceGuildIds: ["guild-1"],
    });
    await expect(
      runtime(jsonFetch({})).execute(
        write({
          action: "discord.presence.go_live_start",
          payload: { kind: "go_live_start", guildId: "guild-1", channelId: "voice-1" },
        }),
        goLiveSession,
      ),
    ).rejects.toThrow(/discord_presence_go_live_media_unavailable/u);
  });

  it("publishes and stops Go Live through the injected media publisher", async () => {
    const goLiveSession = DiscordPresenceSessionRecordSchema.parse({
      ...present,
      phase: "voice_active",
      voiceGuildIds: ["guild-1"],
    });
    const started: { guildId: string; channelId: string }[] = [];
    const stopped: string[] = [];
    const media = {
      active: false,
      start: (input: { guildId: string; channelId: string }) => {
        started.push({ guildId: input.guildId, channelId: input.channelId });
        return Promise.resolve();
      },
      stop: (guildId: string) => {
        stopped.push(guildId);
        return Promise.resolve();
      },
    };
    const withMedia = new DiscordUserPresenceRuntime({
      token: "user-token",
      fetch: jsonFetch({}),
      goLiveMedia: media,
      // The surface being streamed is a composition choice, not something the
      // executor knows about.
      resolveGoLiveSource: () => Readable.from(["frame-bytes"]),
    });

    await expect(
      withMedia.execute(
        write({
          action: "discord.presence.go_live_start",
          payload: { kind: "go_live_start", guildId: "guild-1", channelId: "voice-1" },
        }),
        goLiveSession,
      ),
    ).resolves.toMatchObject({ action: "discord.presence.go_live_start", transportKind: "user_session" });
    expect(started).toEqual([{ guildId: "guild-1", channelId: "voice-1" }]);

    await withMedia.execute(
      write({
        action: "discord.presence.go_live_stop",
        payload: { kind: "go_live_stop", guildId: "guild-1" },
      }),
      DiscordPresenceSessionRecordSchema.parse({ ...goLiveSession, phase: "go_live_active" }),
    );
    expect(stopped).toEqual(["guild-1"]);
  });

  it("reports a REST failure by status and route, never by response body", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("secret channel content", { status: 403 })),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      runtime(fetchImpl).execute(
        write({
          action: "discord.presence.reply",
          payload: { kind: "reply", channelId: "channel-1", messageId: "message-1", content: "hi" },
        }),
        present,
      ),
    ).rejects.toThrow(/discord_user_session_rest_failed:403:POST/u);
  });

  it("encodes unicode and custom reaction emoji for the REST path", () => {
    expect(encodeReactionEmoji("👍")).toBe(encodeURIComponent("👍"));
    expect(encodeReactionEmoji("<:clankie:12345>")).toBe("clankie:12345");
    expect(encodeReactionEmoji("clankie:12345")).toBe("clankie:12345");
    expect(() => encodeReactionEmoji("bad:")).toThrow(/discord_presence_invalid_emoji/u);
  });
});

const present = DiscordPresenceSessionRecordSchema.parse({
  schemaVersion: 1,
  sessionId: "discord:user_session:fixture",
  characterId: "clankie",
  credentialRef: "discord_user_session",
  transportKind: "user_session",
  phase: "present",
  gatewayConnected: true,
  voiceGuildIds: [],
  revision: 1,
  updatedAt: "2026-07-25T18:00:00.000Z",
});

function runtime(fetchImpl: typeof globalThis.fetch): DiscordUserPresenceRuntime {
  return new DiscordUserPresenceRuntime({ token: "user-token", fetch: fetchImpl });
}

function jsonFetch(body: unknown) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    ),
  ) as unknown as typeof globalThis.fetch & { mock: { calls: unknown[][] } };
}

function write(partial: Pick<DiscordPresenceWrite, "action" | "payload">): DiscordPresenceWrite {
  return {
    schemaVersion: 1,
    idempotencyKey: `id-${partial.action}`,
    identity: {
      missionId: "mission-1",
      correlationId: "corr-1",
      profileHash: "profile-1",
      characterId: "clankie",
      credentialRef: "discord_user_session",
      transportKind: "user_session",
    },
    ...partial,
  };
}
