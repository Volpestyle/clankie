import { describe, expect, it } from "vitest";
import {
  buildDiscordStreamKey,
  createDiscordStreamDiscovery,
  deriveDiscordStreamWatchDaveChannelId,
} from "../src/stream-discovery.ts";

describe("Discord stream discovery", () => {
  it("lists a share from self_stream and sends STREAM_WATCH", () => {
    const sent: { op: number; d: unknown }[] = [];
    const listed: string[] = [];
    const discovery = createDiscordStreamDiscovery(
      {
        send: (payload) => {
          sent.push(payload);
          return true;
        },
      },
      { onStreamListed: (stream) => listed.push(stream.streamKey) },
    );

    discovery.handle({
      t: "VOICE_STATE_UPDATE",
      d: {
        guild_id: "guild-1",
        channel_id: "voice-1",
        user_id: "human-1",
        self_stream: true,
      },
    });

    const key = buildDiscordStreamKey({ guildId: "guild-1", channelId: "voice-1", userId: "human-1" });
    expect(listed).toEqual([key]);
    discovery.requestWatch(key);
    expect(sent).toContainEqual({ op: 20, d: { stream_key: key } });
  });

  it("forwards stream-server credentials and forgets a share that ends", () => {
    const credentials: string[] = [];
    const deleted: string[] = [];
    const discovery = createDiscordStreamDiscovery(
      { send: () => true },
      {
        onStreamCredentials: (stream) => credentials.push(stream.streamKey),
        onStreamDeleted: (stream) => deleted.push(stream.streamKey),
      },
    );
    const key = buildDiscordStreamKey({ guildId: "guild-1", channelId: "voice-1", userId: "human-1" });
    discovery.handle({
      t: "STREAM_CREATE",
      d: {
        stream_key: key,
        endpoint: "stream.discord.gg",
        token: "stream-token",
        rtc_server_id: "99",
      },
    });
    expect(credentials).toEqual([key]);
    expect(deriveDiscordStreamWatchDaveChannelId("99")).toBe("98");

    discovery.handle({
      t: "VOICE_STATE_UPDATE",
      d: { guild_id: "guild-1", user_id: "human-1", self_stream: false },
    });
    expect(deleted).toEqual([key]);
    expect(discovery.listStreams()).toEqual([]);
  });

  it("sends publish opcodes", () => {
    const sent: { op: number; d: unknown }[] = [];
    const discovery = createDiscordStreamDiscovery({
      send: (payload) => {
        sent.push(payload);
        return true;
      },
    });
    expect(discovery.requestPublish({ kind: "guild", guildId: "g1", channelId: "c1" })).toBe(true);
    expect(sent[0]).toMatchObject({ op: 18, d: { type: "guild", guild_id: "g1", channel_id: "c1" } });
  });
});
