import type { VoxControlEvent, VoxStreamClient } from "@clankie/vox-client";
import { describe, expect, it } from "vitest";
import { startStreamWatch } from "../src/stream-watch.ts";
import type { DiscordUserGateway } from "../src/gateway.ts";
import { buildDiscordStreamKey } from "../src/stream-discovery.ts";

function fakeVox(): VoxStreamClient & {
  commands: Record<string, unknown>[];
  emitEvent(event: VoxControlEvent): void;
} {
  const commands: Record<string, unknown>[] = [];
  let eventListener: ((event: VoxControlEvent) => void) | undefined;
  return {
    available: true,
    status: "ready",
    detail: "test",
    commands,
    emitEvent: (event) => eventListener?.(event),
    streamWatchConnect: (input) => commands.push({ type: "stream_watch_connect", ...input }),
    streamWatchDisconnect: (reason) => commands.push({ type: "stream_watch_disconnect", reason }),
    subscribeUserVideo: (userId) => commands.push({ type: "subscribe_user_video", userId }),
    unsubscribeUserVideo: (userId) => commands.push({ type: "unsubscribe_user_video", userId }),
    streamPublishConnect: (input) => commands.push({ type: "stream_publish_connect", ...input }),
    streamPublishDisconnect: (reason) => commands.push({ type: "stream_publish_disconnect", reason }),
    streamPublishPlay: (url) => commands.push({ type: "stream_publish_play", url }),
    streamPublishBrowserStart: (mimeType) =>
      commands.push({ type: "stream_publish_browser_start", mimeType }),
    streamPublishBrowserFrame: (input) => commands.push({ type: "stream_publish_browser_frame", ...input }),
    streamPublishStop: () => commands.push({ type: "stream_publish_stop" }),
    streamPublishPause: () => commands.push({ type: "stream_publish_pause" }),
    streamPublishResume: () => commands.push({ type: "stream_publish_resume" }),
    onStatus(listener) {
      listener("ready", "test");
    },
    onEvent(listener) {
      eventListener = listener;
    },
    onDecodedFrame() {},
    close() {},
  };
}

function fakeGateway(): DiscordUserGateway & {
  payloads: unknown[];
  voiceStates: unknown[];
  setVoiceSessionId(value: string | undefined): void;
} {
  const payloads: unknown[] = [];
  const voiceStates: unknown[] = [];
  let voiceSessionId: string | undefined = "voice-session-1";
  return {
    userId: "self-1",
    get voiceSessionId() {
      return voiceSessionId;
    },
    payloads,
    voiceStates,
    setVoiceSessionId(value: string | undefined) {
      voiceSessionId = value;
    },
    sendPayload: (payload: unknown) => {
      payloads.push(payload);
      return true;
    },
    sendVoiceStateUpdate: (payload: unknown) => {
      voiceStates.push(payload);
      return true;
    },
  } as unknown as DiscordUserGateway & {
    payloads: unknown[];
    voiceStates: unknown[];
    setVoiceSessionId(value: string | undefined): void;
  };
}

describe("stream watch / publish controller", () => {
  it("plays a URL through ClankVox when go-live credentials arrive for self", () => {
    const vox = fakeVox();
    const reports: unknown[] = [];
    const publishEvents: string[] = [];
    const gateway = fakeGateway();
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async (report: unknown) => reports.push(report) } as never,
      allowlisted: () => true,
      vox,
      onPublishEvent: (type) => publishEvents.push(type),
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
    expect(publishEvents).toEqual([]);
    vox.emitEvent({ type: "transport_state", role: "stream_publish", status: "ready" });
    expect(publishEvents).toEqual(["publish_started"]);
    expect(gateway.payloads).toContainEqual({ op: 22, d: { stream_key: key, paused: false } });
    expect(controller.playSource("https://youtu.be/next")).toBe(true);
    expect(vox.commands).toContainEqual({ type: "stream_publish_play", url: "https://youtu.be/next" });
    controller.setPublishPaused(true);
    expect(vox.commands).toContainEqual({ type: "stream_publish_pause" });
    controller.setPublishPaused(false);
    expect(vox.commands).toContainEqual({ type: "stream_publish_resume" });
    controller.close();
  });

  it("pumps activity PNG frames when no URL is given", async () => {
    const vox = fakeVox();
    const controller = startStreamWatch({
      gateway: fakeGateway(),
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox,
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
      vox: fakeVox(),
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

  it("waits for transport readiness and watches only one remote stream at a time", () => {
    const gateway = fakeGateway();
    const vox = fakeVox();
    const watchEvents: string[] = [];
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox,
      onWatchEvent: (type) => watchEvents.push(type),
    });
    const first = buildDiscordStreamKey({ guildId: "guild-1", channelId: "voice-1", userId: "user-1" });
    const second = buildDiscordStreamKey({ guildId: "guild-1", channelId: "voice-1", userId: "user-2" });

    for (const streamKey of [first, second]) {
      controller.handleRaw({
        t: "STREAM_CREATE",
        d: { stream_key: streamKey, endpoint: "stream.discord.gg", token: "tok", rtc_server_id: "10" },
      });
    }
    expect(vox.commands.filter((command) => command.type === "stream_watch_connect")).toHaveLength(1);
    expect(watchEvents).toEqual([]);

    vox.emitEvent({ type: "transport_state", role: "stream_watch", status: "ready" });
    expect(watchEvents).toEqual(["watch_connected"]);

    controller.handleRaw({ t: "STREAM_DELETE", d: { stream_key: first } });
    expect(vox.commands.filter((command) => command.type === "stream_watch_connect")).toHaveLength(2);
    controller.close();
  });

  it("retries credentials that arrive before the voice session id", () => {
    const gateway = fakeGateway();
    gateway.setVoiceSessionId(undefined);
    const vox = fakeVox();
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox,
    });
    const streamKey = buildDiscordStreamKey({
      guildId: "guild-1",
      channelId: "voice-1",
      userId: "user-1",
    });

    controller.handleRaw({
      t: "STREAM_CREATE",
      d: { stream_key: streamKey, endpoint: "stream.discord.gg", token: "tok", rtc_server_id: "10" },
    });
    expect(vox.commands.filter((command) => command.type === "stream_watch_connect")).toHaveLength(0);

    gateway.setVoiceSessionId("voice-session-1");
    controller.publish();

    expect(vox.commands.filter((command) => command.type === "stream_watch_connect")).toHaveLength(1);
    controller.close();
  });
});
