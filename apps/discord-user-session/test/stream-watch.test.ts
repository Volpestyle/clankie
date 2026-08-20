import { VOX_IPC_PROTOCOL_VERSION, type VoxControlEvent, type VoxStreamClient } from "@clankie/vox-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startStreamWatch } from "../src/stream-watch.ts";
import type { DiscordUserGateway } from "../src/gateway.ts";
import { buildDiscordStreamKey } from "../src/stream-discovery.ts";
import { VoiceMembershipCoordinator } from "../src/vox-gateway.ts";

const GUILD = "222222222222222222";
const CHANNEL = "444444444444444444";
const OTHER_CHANNEL = "555555555555555555";
const SELF = "666666666666666666";
const USER_ONE = "777777777777777777";
const USER_TWO = "888888888888888888";

function fakeVox(): VoxStreamClient & {
  commands: Record<string, unknown>[];
  closeCalls: number;
  emitEvent(event: VoxControlEvent): void;
  emitStatus(status: VoxStreamClient["status"]): void;
} {
  const commands: Record<string, unknown>[] = [];
  const eventListeners = new Set<(event: VoxControlEvent) => void>();
  const statusListeners = new Set<(status: VoxStreamClient["status"], detail: string) => void>();
  return {
    available: true,
    status: "ready",
    detail: "test",
    commands,
    closeCalls: 0,
    emitEvent: (event) => {
      for (const listener of eventListeners) listener(event);
    },
    emitStatus: (status) => {
      for (const listener of statusListeners) listener(status, "test");
    },
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
      statusListeners.add(listener);
      listener("ready", "test");
      return () => statusListeners.delete(listener);
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onDecodedFrame() {
      return () => undefined;
    },
    close() {
      this.closeCalls += 1;
    },
  };
}

function fakeGateway(): DiscordUserGateway & {
  payloads: unknown[];
  setVoiceSessionId(value: string | undefined): void;
  failOpcode(value: number | undefined): void;
} {
  const payloads: unknown[] = [];
  let voiceSessionId: string | undefined = "voice-session-1";
  let failedOpcode: number | undefined;
  return {
    userId: SELF,
    get voiceSessionId() {
      return voiceSessionId;
    },
    payloads,
    setVoiceSessionId(value: string | undefined) {
      voiceSessionId = value;
    },
    failOpcode(value: number | undefined) {
      failedOpcode = value;
    },
    sendPayload: (payload: unknown) => {
      payloads.push(payload);
      if ((payload as { op?: unknown }).op === failedOpcode) return false;
      return true;
    },
  } as unknown as DiscordUserGateway & {
    payloads: unknown[];
    setVoiceSessionId(value: string | undefined): void;
    failOpcode(value: number | undefined): void;
  };
}

describe("stream watch / publish controller", () => {
  afterEach(() => vi.useRealTimers());

  it("plays a URL through Vox and proves publish only after first accepted H264", async () => {
    const vox = fakeVox();
    const reports: unknown[] = [];
    const publishEvents: string[] = [];
    const gateway = fakeGateway();
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async (report: unknown) => reports.push(report) } as never,
      allowlisted: () => true,
      vox,
      membership: new VoiceMembershipCoordinator(gateway),
      onPublishEvent: (type) => publishEvents.push(type),
    });
    const started = controller.requestPublish({
      guildId: GUILD,
      channelId: CHANNEL,
      sourceUrl: "https://example.com/clip.mp4",
    });
    expect(gateway.payloads).toContainEqual({
      op: 4,
      d: {
        guild_id: GUILD,
        channel_id: CHANNEL,
        self_mute: true,
        self_deaf: true,
      },
    });
    expect(gateway.payloads).toContainEqual({
      op: 18,
      d: { type: "guild", guild_id: GUILD, channel_id: CHANNEL, preferred_region: null },
    });
    const key = buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: SELF });
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
    await expect(started).resolves.toBe(true);
    expect(publishEvents).toEqual([]);
    vox.emitEvent({ type: "transport_state", role: "stream_publish", status: "ready" });
    expect(publishEvents).toEqual([]);
    vox.emitEvent({
      type: "dave_state",
      role: "stream_publish",
      status: "ready",
      protocolVersion: VOX_IPC_PROTOCOL_VERSION,
    });
    expect(publishEvents).toEqual([]);
    vox.emitEvent({
      type: "stream_publish_media_started",
      role: "stream_publish",
      connectionGeneration: 1,
      sourceGeneration: 1,
    });
    expect(publishEvents).toEqual(["publish_started"]);
    expect(gateway.payloads).toContainEqual({ op: 22, d: { stream_key: key, paused: false } });
    expect(controller.playSource("https://youtu.be/next")).toBe(true);
    expect(vox.commands).toContainEqual({ type: "stream_publish_play", url: "https://youtu.be/next" });
    controller.setPublishPaused(true);
    expect(vox.commands).toContainEqual({ type: "stream_publish_pause" });
    controller.setPublishPaused(false);
    expect(vox.commands).toContainEqual({ type: "stream_publish_resume" });
    controller.close();
    expect(vox.closeCalls).toBe(0);
  });

  it("pumps activity PNG frames when no URL is given", async () => {
    const vox = fakeVox();
    const gateway = fakeGateway();
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox,
      membership: new VoiceMembershipCoordinator(gateway),
      fetchActivitySnapshot: async () => ({
        mimeType: "image/png",
        data: "cG5n",
        sha256: "digest-1",
      }),
    });
    const started = controller.requestPublish({ guildId: GUILD, channelId: CHANNEL });
    const key = buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: SELF });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: { stream_key: key, endpoint: "stream.discord.gg", token: "tok", rtc_server_id: "10" },
    });
    await expect(started).resolves.toBe(true);
    expect(vox.commands).toContainEqual({ type: "stream_publish_browser_start", mimeType: "image/png" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(vox.commands.some((command) => command.type === "stream_publish_browser_frame")).toBe(true);
    controller.close();
  });

  it("keeps a stream-only membership muted and deafened", () => {
    const gateway = fakeGateway();
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox: fakeVox(),
      membership: new VoiceMembershipCoordinator(gateway),
    });
    void controller.requestPublish({ guildId: GUILD, channelId: CHANNEL });
    expect(gateway.payloads).toContainEqual({
      op: 4,
      d: {
        guild_id: GUILD,
        channel_id: CHANNEL,
        self_mute: true,
        self_deaf: true,
      },
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
      membership: new VoiceMembershipCoordinator(gateway),
      onWatchEvent: (type) => watchEvents.push(type),
    });
    const first = buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: USER_ONE });
    const second = buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: USER_TWO });

    for (const streamKey of [first, second]) {
      controller.handleRaw({
        t: "STREAM_CREATE",
        d: { stream_key: streamKey, endpoint: "stream.discord.gg", token: "tok", rtc_server_id: "10" },
      });
    }
    expect(vox.commands.filter((command) => command.type === "stream_watch_connect")).toHaveLength(1);
    expect(watchEvents).toEqual([]);

    vox.emitEvent({ type: "transport_state", role: "stream_watch", status: "ready" });
    expect(watchEvents).toEqual([]);
    vox.emitEvent({
      type: "dave_state",
      role: "stream_watch",
      status: "ready",
      protocolVersion: VOX_IPC_PROTOCOL_VERSION,
    });
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
      membership: new VoiceMembershipCoordinator(gateway),
    });
    const streamKey = buildDiscordStreamKey({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: USER_ONE,
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

  it("refuses direct publishing outside the allowlist without joining", async () => {
    const gateway = fakeGateway();
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: (_guildId, channelId) => channelId === CHANNEL,
      vox: fakeVox(),
      membership: new VoiceMembershipCoordinator(gateway),
    });

    await expect(controller.requestPublish({ guildId: GUILD, channelId: OTHER_CHANNEL })).resolves.toBe(
      false,
    );
    expect(gateway.payloads).toEqual([]);
    controller.close();
  });

  it("keeps active voice joined when Discord deletes the published stream", async () => {
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway);
    membership.acquire("voice", GUILD, CHANNEL, {
      op: 4,
      d: {
        guild_id: GUILD,
        channel_id: CHANNEL,
        self_mute: false,
        self_deaf: false,
      },
    });
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox,
      membership,
    });
    const started = controller.requestPublish({ guildId: GUILD, channelId: CHANNEL });
    const streamKey = buildDiscordStreamKey({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: SELF,
    });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: { stream_key: streamKey, endpoint: "stream.discord.gg", token: "tok", rtc_server_id: "10" },
    });
    await expect(started).resolves.toBe(true);
    controller.handleRaw({ t: "STREAM_DELETE", d: { stream_key: streamKey } });

    expect(membership.target).toEqual({ guildId: GUILD, channelId: CHANNEL });
    expect(gateway.payloads).not.toContainEqual(expect.objectContaining({ op: 4, d: { channel_id: null } }));
    controller.close();
  });

  it("releases leases when OP20 or OP18 is refused", async () => {
    const gateway = fakeGateway();
    const membership = new VoiceMembershipCoordinator(gateway);
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox: fakeVox(),
      membership,
    });
    gateway.failOpcode(20);
    controller.handleRaw({
      t: "VOICE_STATE_UPDATE",
      d: { guild_id: GUILD, channel_id: CHANNEL, user_id: USER_ONE, self_stream: true },
    });
    expect(membership.target).toBeUndefined();

    gateway.failOpcode(18);
    await expect(controller.requestPublish({ guildId: GUILD, channelId: CHANNEL })).resolves.toBe(false);
    expect(membership.target).toBeUndefined();
    controller.close();
  });

  it("automatically reconnects a listed watch after a scoped transport failure", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway);
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox,
      membership,
    });
    const remote = buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: USER_ONE });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: { stream_key: remote, endpoint: "stream.discord.gg", token: "tok", rtc_server_id: "10" },
    });
    vox.emitEvent({
      type: "error",
      code: "stream_watch_connect_failed",
      message: "network_lost",
      role: "stream_watch",
    });
    expect(membership.target).toEqual({ guildId: GUILD, channelId: CHANNEL });
    await vi.advanceTimersByTimeAsync(250);
    expect(vox.commands.filter((command) => command.type === "stream_watch_connect")).toHaveLength(2);

    controller.handleRaw({ t: "STREAM_DELETE", d: { stream_key: remote } });
    vox.emitEvent({
      type: "error",
      code: "stream_watch_connect_failed",
      message: "late_failure",
      role: "stream_watch",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vox.commands.filter((command) => command.type === "stream_watch_connect")).toHaveLength(2);
    controller.close();
  });

  it("releases a watch deleted during backoff and can join another channel", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway);
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox,
      membership,
    });
    const first = buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: USER_ONE });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: { stream_key: first, endpoint: "stream.discord.gg", token: "tok", rtc_server_id: "10" },
    });
    vox.emitEvent({
      type: "error",
      code: "stream_watch_connect_failed",
      message: "network_lost",
      role: "stream_watch",
    });
    expect(membership.targetFor("stream_watch")).toEqual({ guildId: GUILD, channelId: CHANNEL });

    controller.handleRaw({ t: "STREAM_DELETE", d: { stream_key: first } });
    expect(membership.targetFor("stream_watch")).toBeUndefined();

    const second = buildDiscordStreamKey({
      guildId: GUILD,
      channelId: OTHER_CHANNEL,
      userId: USER_TWO,
    });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: { stream_key: second, endpoint: "stream.discord.gg", token: "tok", rtc_server_id: "11" },
    });
    expect(membership.targetFor("stream_watch")).toEqual({
      guildId: GUILD,
      channelId: OTHER_CHANNEL,
    });
    expect(vox.commands.filter((command) => command.type === "stream_watch_connect")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vox.commands.filter((command) => command.type === "stream_watch_connect")).toHaveLength(2);
    controller.close();
  });

  it("releases the retained watch lease when reconnect attempts are exhausted", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway);
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox,
      membership,
    });
    const remote = buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: USER_ONE });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: { stream_key: remote, endpoint: "stream.discord.gg", token: "tok", rtc_server_id: "10" },
    });

    for (const delay of [250, 500, 1_000, 2_000, 4_000]) {
      vox.emitEvent({
        type: "error",
        code: "stream_watch_connect_failed",
        message: "network_lost",
        role: "stream_watch",
      });
      expect(membership.targetFor("stream_watch")).toEqual({ guildId: GUILD, channelId: CHANNEL });
      await vi.advanceTimersByTimeAsync(delay);
    }
    vox.emitEvent({
      type: "error",
      code: "stream_watch_connect_failed",
      message: "network_lost",
      role: "stream_watch",
    });
    expect(membership.targetFor("stream_watch")).toBeUndefined();
    controller.close();
  });

  it("releases only the watch lease when a retry becomes disallowed", async () => {
    vi.useFakeTimers();
    let allowed = true;
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway);
    expect(membership.acquire("voice", GUILD, CHANNEL)).toBe(true);
    expect(membership.acquire("stream_publish", GUILD, CHANNEL)).toBe(true);
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => allowed,
      vox,
      membership,
    });
    const remote = buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: USER_ONE });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: { stream_key: remote, endpoint: "stream.discord.gg", token: "tok", rtc_server_id: "10" },
    });
    vox.emitEvent({
      type: "error",
      code: "stream_watch_connect_failed",
      message: "network_lost",
      role: "stream_watch",
    });
    allowed = false;
    expect(membership.targetFor("stream_watch")).toEqual({ guildId: GUILD, channelId: CHANNEL });

    await vi.advanceTimersByTimeAsync(250);
    expect(membership.targetFor("stream_watch")).toBeUndefined();
    expect(membership.targetFor("voice")).toEqual({ guildId: GUILD, channelId: CHANNEL });
    expect(membership.targetFor("stream_publish")).toEqual({ guildId: GUILD, channelId: CHANNEL });
    controller.close();
  });

  it("releases failed publish transports and can request another publish", async () => {
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway);
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox,
      membership,
    });

    const started = controller.requestPublish({ guildId: GUILD, channelId: CHANNEL });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: {
        stream_key: buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: SELF }),
        endpoint: "stream.discord.gg",
        token: "tok",
        rtc_server_id: "10",
      },
    });
    await expect(started).resolves.toBe(true);
    vox.emitEvent({
      type: "error",
      code: "stream_publish_connect_failed",
      message: "network_lost",
      role: "stream_publish",
    });
    expect(membership.targetFor("stream_publish")).toBeUndefined();
    void controller.requestPublish({ guildId: GUILD, channelId: CHANNEL });
    controller.close();
  });

  it("fails start when OP22 is refused and propagates OP19 stop failure", async () => {
    const gateway = fakeGateway();
    const membership = new VoiceMembershipCoordinator(gateway);
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox: fakeVox(),
      membership,
    });
    gateway.failOpcode(22);
    const failed = controller.requestPublish({ guildId: GUILD, channelId: CHANNEL });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: {
        stream_key: buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: SELF }),
        endpoint: "stream.discord.gg",
        token: "tok",
        rtc_server_id: "10",
      },
    });
    await expect(failed).resolves.toBe(false);
    expect(membership.targetFor("stream_publish")).toBeUndefined();

    gateway.failOpcode(undefined);
    const started = controller.requestPublish({ guildId: GUILD, channelId: CHANNEL });
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: {
        stream_key: buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: SELF }),
        endpoint: "stream.discord.gg",
        token: "tok",
        rtc_server_id: "10",
      },
    });
    await expect(started).resolves.toBe(true);
    gateway.failOpcode(19);
    expect(controller.stopPublish()).toBe(false);
    controller.close();
  });

  it("ignores an interleaved raw dispatch after shutdown starts", async () => {
    const gateway = fakeGateway();
    const vox = fakeVox();
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox,
      membership: new VoiceMembershipCoordinator(gateway),
    });
    controller.close();
    const commandCount = vox.commands.length;
    const payloadCount = gateway.payloads.length;
    controller.handleRaw({
      t: "STREAM_CREATE",
      d: {
        stream_key: buildDiscordStreamKey({ guildId: GUILD, channelId: CHANNEL, userId: USER_ONE }),
        endpoint: "stream.discord.gg",
        token: "tok",
        rtc_server_id: "10",
      },
    });
    vox.emitEvent({ type: "transport_state", role: "stream_watch", status: "ready" });
    vox.emitEvent({
      type: "dave_state",
      role: "stream_watch",
      status: "ready",
      protocolVersion: VOX_IPC_PROTOCOL_VERSION,
    });
    await expect(controller.requestPublish({ guildId: GUILD, channelId: CHANNEL })).resolves.toBe(false);
    expect(vox.commands).toHaveLength(commandCount);
    expect(gateway.payloads).toHaveLength(payloadCount);
  });

  it("quiesces controllers and releases leases when Vox exits unexpectedly", async () => {
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway);
    const controller = startStreamWatch({
      gateway,
      api: { reportDiscordStreamWatch: async () => ({}) } as never,
      allowlisted: () => true,
      vox,
      membership,
    });
    void controller.requestPublish({ guildId: GUILD, channelId: CHANNEL });
    vox.emitStatus("error");
    expect(membership.target).toBeUndefined();
    await expect(controller.requestPublish({ guildId: GUILD, channelId: CHANNEL })).resolves.toBe(false);
  });
});
