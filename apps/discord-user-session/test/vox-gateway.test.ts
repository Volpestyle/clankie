import type { VoxClient, VoxControlEvent } from "@clankie/vox-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordUserGateway } from "../src/gateway.ts";
import { VoiceMembershipCoordinator, VoxGatewayBridge } from "../src/vox-gateway.ts";

const GUILD_A = "222222222222222222";
const GUILD_B = "333333333333333333";
const CHANNEL_A = "444444444444444444";
const CHANNEL_B = "555555555555555555";
const SELF = "666666666666666666";

describe("sole-Vox gateway and membership", () => {
  afterEach(() => vi.useRealTimers());

  it("forwards only exact, explicitly targeted, allowlisted Vox OP4 payloads", () => {
    const gateway = fakeGateway();
    const vox = fakeVox();
    const rejected: string[] = [];
    const bridge = createBridge(
      gateway.value,
      vox.value,
      new VoiceMembershipCoordinator(gateway.value),
      rejected,
    );
    const join = voicePayload(GUILD_A, CHANNEL_A, false, false);
    const leave = voicePayload(GUILD_A, null, false, false);

    vox.emit({ type: "adapter_send", payload: join });
    expect(bridge.prepareVoiceTarget(GUILD_A, CHANNEL_A)).toBe(true);
    vox.emit({ type: "adapter_send", payload: { ...join, extra: true } });
    vox.emit({ type: "adapter_send", payload: { ...join, d: { ...join.d, extra: true } } });
    vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, CHANNEL_A, true, false) });
    vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, CHANNEL_B, false, false) });
    vox.emit({ type: "adapter_send", payload: join });
    gateway.emit("voiceStateUpdate", voiceState(GUILD_A, SELF, CHANNEL_A));
    vox.emit({ type: "adapter_send", payload: leave });

    expect(gateway.payloads).toEqual([join, leave]);
    expect(rejected).toEqual([
      "unexpected_adapter_send",
      "invalid_adapter_send",
      "invalid_adapter_send",
      "invalid_adapter_send",
      "unexpected_adapter_send",
    ]);
    bridge.dispose();
  });

  it("accepts gateway updates only for the explicit target and reconciles external leave before rejoin", () => {
    const gateway = fakeGateway();
    const vox = fakeVox();
    const rejected: string[] = [];
    const membership = new VoiceMembershipCoordinator(gateway.value);
    const bridge = createBridge(gateway.value, vox.value, membership, rejected);
    bridge.prepareVoiceTarget(GUILD_A, CHANNEL_A);
    vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, CHANNEL_A, false, false) });

    gateway.emit("voiceServerUpdate", { guildId: GUILD_B, token: "wrong", endpoint: "wrong" });
    gateway.emit("voiceStateUpdate", voiceState(GUILD_A, "777777777777777777", CHANNEL_A));
    gateway.emit("voiceServerUpdate", { guildId: GUILD_A, token: "token", endpoint: null });
    gateway.emit("voiceStateUpdate", {
      guildId: GUILD_A,
      userId: SELF,
      raw: { guild_id: GUILD_A, user_id: SELF, session_id: null, channel_id: null },
    });

    expect(vox.servers).toEqual([{ token: "token", endpoint: null }]);
    expect(vox.states).toEqual([{ user_id: SELF, session_id: null, channel_id: null }]);
    expect(membership.target).toBeUndefined();
    expect(bridge.prepareVoiceTarget(GUILD_B, CHANNEL_B)).toBe(true);
    vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_B, CHANNEL_B, false, false) });
    expect(membership.target).toEqual({ guildId: GUILD_B, channelId: CHANNEL_B });
    expect(rejected).toEqual(["unrelated_voice_server_update", "unrelated_voice_state_update"]);
    bridge.dispose();
  });

  it("clears stale leases on an external move so a new target can join", () => {
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway.value);
    const bridge = createBridge(gateway.value, vox.value, membership, []);

    expect(membership.acquire("stream_watch", GUILD_A, CHANNEL_A)).toBe(true);
    gateway.emit("voiceStateUpdate", voiceState(GUILD_A, SELF, CHANNEL_B));
    expect(membership.target).toBeUndefined();
    expect(vox.states).toEqual([{ user_id: SELF, session_id: "888888888888888888", channel_id: null }]);
    expect(membership.acquire("stream_watch", GUILD_B, CHANNEL_B)).toBe(true);
    bridge.dispose();
  });

  it("preserves leases and reports failure when Discord refuses membership sends", () => {
    const gateway = fakeGateway();
    const membership = new VoiceMembershipCoordinator(gateway.value);
    gateway.sendResult = false;

    expect(membership.acquire("stream_publish", GUILD_A, CHANNEL_A)).toBe(false);
    expect(membership.target).toBeUndefined();
    gateway.sendResult = true;
    expect(membership.acquire("stream_publish", GUILD_A, CHANNEL_A)).toBe(true);
    gateway.sendResult = false;
    expect(membership.release("stream_publish", GUILD_A)).toBe(false);
    expect(membership.target).toEqual({ guildId: GUILD_A, channelId: CHANNEL_A });
    gateway.sendResult = true;
    expect(membership.release("stream_publish", GUILD_A)).toBe(true);
    expect(membership.target).toBeUndefined();
  });

  it("keeps watch muted when ordinary voice leaves and keeps voice when publish leaves", () => {
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway.value);
    const bridge = createBridge(gateway.value, vox.value, membership, []);

    membership.acquire("stream_watch", GUILD_A, CHANNEL_A);
    bridge.prepareVoiceTarget(GUILD_A, CHANNEL_A);
    vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, CHANNEL_A, false, false) });
    gateway.emit("voiceStateUpdate", voiceState(GUILD_A, SELF, CHANNEL_A));
    membership.acquire("stream_publish", GUILD_A, CHANNEL_A);
    const beforePublishLeave = gateway.payloads.length;
    membership.release("stream_publish", GUILD_A);
    expect(gateway.payloads).toHaveLength(beforePublishLeave);

    vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, null, false, false) });
    expect(membership.targetFor("voice")).toBeUndefined();
    expect(membership.targetFor("stream_watch")).toEqual({ guildId: GUILD_A, channelId: CHANNEL_A });
    expect(gateway.payloads.at(-1)).toEqual(voicePayload(GUILD_A, CHANNEL_A, true, true));
    bridge.dispose();
  });

  it("rejects invalid snowflakes and configured ordinary-voice targets outside the allowlist", () => {
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway.value);
    const bridge = new VoxGatewayBridge({
      gateway: gateway.value,
      vox: vox.value,
      membership,
      allowlisted: (guildId, channelId) => guildId === GUILD_A && channelId === CHANNEL_A,
    });
    expect(bridge.prepareVoiceTarget("guild-a", CHANNEL_A)).toBe(false);
    expect(bridge.prepareVoiceTarget("0", CHANNEL_A)).toBe(false);
    expect(bridge.prepareVoiceTarget(GUILD_A, CHANNEL_B)).toBe(false);
    expect(membership.acquire("stream_watch", "guild-a", CHANNEL_A)).toBe(false);
    expect(gateway.payloads).toEqual([]);
    bridge.dispose();
  });

  it("serializes a rapid channel switch behind the old null acknowledgement", async () => {
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway.value);
    const bridge = createBridge(gateway.value, vox.value, membership, []);
    expect(bridge.prepareVoiceTarget(GUILD_A, CHANNEL_A)).toBe(true);
    const joined = bridge.confirmVoiceJoin(GUILD_A, CHANNEL_A, async () => {
      vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, CHANNEL_A, false, false) });
    });
    gateway.emit("voiceStateUpdate", voiceState(GUILD_A, SELF, CHANNEL_A));
    await expect(joined).resolves.toBe(true);

    const switched = (async () => {
      const left = await bridge.confirmVoiceLeave(GUILD_A, async () => {
        vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, null, false, false) });
      });
      if (!left || !bridge.prepareVoiceTarget(GUILD_A, CHANNEL_B)) return false;
      return bridge.confirmVoiceJoin(GUILD_A, CHANNEL_B, async () => {
        vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, CHANNEL_B, false, false) });
      });
    })();

    await Promise.resolve();
    expect(gateway.payloads.at(-1)).toEqual(voicePayload(GUILD_A, null, false, false));
    expect(gateway.payloads).not.toContainEqual(voicePayload(GUILD_A, CHANNEL_B, false, false));
    gateway.emit("voiceStateUpdate", {
      guildId: GUILD_A,
      userId: SELF,
      raw: { guild_id: GUILD_A, user_id: SELF, channel_id: null, session_id: null },
    });
    await vi.waitFor(() =>
      expect(gateway.payloads.at(-1)).toEqual(voicePayload(GUILD_A, CHANNEL_B, false, false)),
    );
    gateway.emit("voiceStateUpdate", voiceState(GUILD_A, SELF, CHANNEL_B));
    await expect(switched).resolves.toBe(true);
    bridge.dispose();
  });

  it("refuses failed OP4 and timeout leaves, then reconciles external null and rejoins", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const vox = fakeVox();
    const membership = new VoiceMembershipCoordinator(gateway.value);
    const bridge = new VoxGatewayBridge({
      gateway: gateway.value,
      vox: vox.value,
      membership,
      allowlisted: () => true,
      voiceStateTimeoutMs: 25,
    });
    bridge.prepareVoiceTarget(GUILD_A, CHANNEL_A);
    const joined = bridge.confirmVoiceJoin(GUILD_A, CHANNEL_A, async () => {
      vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, CHANNEL_A, false, false) });
    });
    gateway.emit("voiceStateUpdate", voiceState(GUILD_A, SELF, CHANNEL_A));
    await expect(joined).resolves.toBe(true);

    gateway.sendResult = false;
    await expect(
      bridge.confirmVoiceLeave(GUILD_A, async () => {
        vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, null, false, false) });
      }),
    ).resolves.toBe(false);
    expect(membership.targetFor("voice")).toEqual({ guildId: GUILD_A, channelId: CHANNEL_A });

    gateway.sendResult = true;
    const retried = bridge.confirmVoiceLeave(GUILD_A, async () => undefined);
    await Promise.resolve();
    expect(gateway.payloads.at(-1)).toEqual(voicePayload(GUILD_A, null, true, true));
    gateway.emit("voiceStateUpdate", {
      guildId: GUILD_A,
      userId: SELF,
      raw: { guild_id: GUILD_A, user_id: SELF, channel_id: null, session_id: null },
    });
    await expect(retried).resolves.toBe(true);

    expect(bridge.prepareVoiceTarget(GUILD_A, CHANNEL_A)).toBe(true);
    const reconnected = bridge.confirmVoiceJoin(GUILD_A, CHANNEL_A, async () => {
      vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, CHANNEL_A, false, false) });
    });
    gateway.emit("voiceStateUpdate", voiceState(GUILD_A, SELF, CHANNEL_A));
    await expect(reconnected).resolves.toBe(true);

    const timedOut = bridge.confirmVoiceLeave(GUILD_A, async () => {
      vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, null, false, false) });
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(timedOut).resolves.toBe(false);
    expect(membership.actualTarget).toEqual({ guildId: GUILD_A, channelId: CHANNEL_A });

    gateway.emit("voiceStateUpdate", {
      guildId: GUILD_A,
      userId: SELF,
      raw: { guild_id: GUILD_A, user_id: SELF, channel_id: null, session_id: null },
    });
    expect(membership.actualTarget).toBeUndefined();
    expect(bridge.prepareVoiceTarget(GUILD_A, CHANNEL_B)).toBe(true);
    const rejoined = bridge.confirmVoiceJoin(GUILD_A, CHANNEL_B, async () => {
      vox.emit({ type: "adapter_send", payload: voicePayload(GUILD_A, CHANNEL_B, false, false) });
    });
    gateway.emit("voiceStateUpdate", voiceState(GUILD_A, SELF, CHANNEL_B));
    await expect(rejoined).resolves.toBe(true);
    bridge.dispose();
  });

  it("resends OP4 when a cached lease is not present in self gateway state", () => {
    const gateway = fakeGateway();
    const membership = new VoiceMembershipCoordinator(gateway.value);
    expect(membership.acquire("stream_watch", GUILD_A, CHANNEL_A)).toBe(true);
    membership.reconcileSelfVoiceState(GUILD_A, CHANNEL_A, false);
    const firstCount = gateway.payloads.length;
    membership.invalidateActualState();
    expect(membership.acquire("stream_watch", GUILD_A, CHANNEL_A)).toBe(true);
    expect(gateway.payloads).toHaveLength(firstCount + 1);
  });
});

function createBridge(
  gateway: DiscordUserGateway,
  vox: VoxClient,
  membership: VoiceMembershipCoordinator,
  rejected: string[],
) {
  return new VoxGatewayBridge({
    gateway,
    vox,
    membership,
    allowlisted: (guildId, channelId) =>
      (guildId === GUILD_A || guildId === GUILD_B) && (channelId === CHANNEL_A || channelId === CHANNEL_B),
    onRejected: (reason) => rejected.push(reason),
  });
}

function voicePayload(guildId: string, channelId: string | null, selfMute: boolean, selfDeaf: boolean) {
  return {
    op: 4,
    d: { guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf },
  } as const;
}

function voiceState(guildId: string, userId: string, channelId: string) {
  return {
    guildId,
    userId,
    channelId,
    raw: {
      guild_id: guildId,
      user_id: userId,
      channel_id: channelId,
      session_id: "888888888888888888",
      self_mute: false,
      self_deaf: false,
    },
  };
}

function fakeGateway() {
  const listeners = new Map<string, Set<(value: never) => void>>();
  const payloads: unknown[] = [];
  let sendResult = true;
  const gateway = {
    userId: SELF,
    sendPayload(payload: unknown) {
      payloads.push(payload);
      return sendResult;
    },
    on(event: string, listener: (value: never) => void) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(listener);
    },
  } as unknown as DiscordUserGateway;
  return {
    value: gateway,
    payloads,
    get sendResult() {
      return sendResult;
    },
    set sendResult(value: boolean) {
      sendResult = value;
    },
    emit(event: string, value: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value as never);
    },
  };
}

function fakeVox() {
  const listeners = new Set<(event: VoxControlEvent) => void>();
  const servers: unknown[] = [];
  const states: unknown[] = [];
  const vox = {
    onEvent(listener: (event: VoxControlEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateVoiceServer(value: unknown) {
      servers.push(value);
    },
    updateVoiceState(value: unknown) {
      states.push(value);
    },
  } as unknown as VoxClient;
  return {
    value: vox,
    servers,
    states,
    emit(event: VoxControlEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}
