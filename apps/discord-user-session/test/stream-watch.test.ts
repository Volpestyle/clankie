import { describe, expect, it } from "vitest";
import { startStreamWatch } from "../src/stream-watch.ts";
import type { ClankvoxSidecar } from "../src/clankvox-sidecar.ts";
import type { DiscordUserGateway } from "../src/gateway.ts";
import { buildDiscordStreamKey } from "../src/stream-discovery.ts";

function fakeVox(): ClankvoxSidecar & { commands: Record<string, unknown>[] } {
  const commands: Record<string, unknown>[] = [];
  return {
    available: true,
    detail: "test",
    commands,
    streamWatchConnect: (input) => commands.push({ type: "stream_watch_connect", ...input }),
    streamWatchDisconnect: (reason) => commands.push({ type: "stream_watch_disconnect", reason }),
    subscribeUserVideo: (userId) => commands.push({ type: "subscribe_user_video", userId }),
    unsubscribeUserVideo: (userId) => commands.push({ type: "unsubscribe_user_video", userId }),
    streamPublishConnect: (input) => commands.push({ type: "stream_publish_connect", ...input }),
    streamPublishDisconnect: (reason) => commands.push({ type: "stream_publish_disconnect", reason }),
    streamPublishPlay: (url) => commands.push({ type: "stream_publish_play", url }),
    streamPublishBrowserStart: (mimeType) => commands.push({ type: "stream_publish_browser_start", mimeType }),
    streamPublishBrowserFrame: (input) => commands.push({ type: "stream_publish_browser_frame", ...input }),
    streamPublishStop: () => commands.push({ type: "stream_publish_stop" }),
    onDecodedFrame() {},
    close() {},
  };
}

function fakeGateway(): DiscordUserGateway & {
  payloads: unknown[];
  voiceStates: unknown[];
} {
  const payloads: unknown[] = [];
  const voiceStates: unknown[] = [];
  return {
    userId: "self-1",
    voiceSessionId: "voice-session-1",
    payloads,
    voiceStates,
    sendPayload: (payload: unknown) => {
      payloads.push(payload);
      return true;
    },
    sendVoiceStateUpdate: (payload: unknown) => {
      voiceStates.push(payload);
      return true;
    },
  } as unknown as DiscordUserGateway & { payloads: unknown[]; voiceStates: unknown[] };
}

describe("stream watch / publish controller", () => {
  it("plays a URL through ClankVox when go-live credentials arrive for self", () => {
    const vox = fakeVox();
    const reports: unknown[] = [];
    const gateway = fakeGateway();
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async (report: unknown) => reports.push(report) } as never,
      allowlisted: () => true,
      clankvox: vox,
    });
    expect(
      controller.requestPublish({
        guildId: "guild-1",
        channelId: "voice-1",
        sourceUrl: "https://example.com/clip.mp4",
      }),
    ).toBe(true);
    expect(gateway.voiceStates).toContainEqual({
      guildId: "guild-1",
      channelId: "voice-1",
      selfMute: true,
      selfDeaf: true,
    });
    expect(gateway.payloads).toContainEqual({
      op: 18,
      d: { type: "guild", guild_id: "guild-1", channel_id: "voice-1", preferred_region: null },
    });
    const key = buildDiscordStreamKey({ guildId: "guild-1", channelId: "voice-1", userId: "self-1" });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: {
        stream_key: key,
        endpoint: "stream.discord.gg",
        token: "tok",
        rtc_server_id: "10",
      },
    });
    expect(vox.commands).toContainEqual(expect.objectContaining({ type: "stream_publish_connect" }));
    expect(vox.commands).toContainEqual({ type: "stream_publish_play", url: "https://example.com/clip.mp4" });
    expect(gateway.payloads).toContainEqual({ op: 22, d: { stream_key: key, paused: false } });
    expect(controller.playSource("https://youtu.be/next")).toBe(true);
    expect(vox.commands).toContainEqual({ type: "stream_publish_play", url: "https://youtu.be/next" });
    controller.close();
  });

  it("pumps activity PNG frames when no URL is given", async () => {
    const vox = fakeVox();
    const controller = startStreamWatch({
      gateway: fakeGateway(),
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      clankvox: vox,
      fetchActivitySnapshot: async () => ({
        mimeType: "image/png",
        data: "cG5n",
        sha256: "digest-1",
      }),
    });
    controller.requestPublish({ guildId: "guild-1", channelId: "voice-1" });
    const key = buildDiscordStreamKey({ guildId: "guild-1", channelId: "voice-1", userId: "self-1" });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: { stream_key: key, endpoint: "stream.discord.gg", token: "tok", rtc_server_id: "10" },
    });
    expect(vox.commands).toContainEqual({ type: "stream_publish_browser_start", mimeType: "image/png" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(vox.commands.some((command) => command.type === "stream_publish_browser_frame")).toBe(true);
    controller.close();
  });

  it("joins unmuted when this process is the active mouth", () => {
    const gateway = fakeGateway();
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      clankvox: fakeVox(),
      joinMuted: false,
    });
    controller.requestPublish({ guildId: "guild-1", channelId: "voice-1" });
    expect(gateway.voiceStates).toContainEqual({
      guildId: "guild-1",
      channelId: "voice-1",
      selfMute: false,
      selfDeaf: false,
    });
    controller.close();
  });
});
