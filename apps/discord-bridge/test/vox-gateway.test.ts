import type {
  InternalDiscordGatewayAdapterCreator,
  InternalDiscordGatewayAdapterLibraryMethods,
} from "discord.js";
import { describe, expect, it } from "vitest";
import { DiscordVoxGatewayBridge, type DiscordVoxGuild, type DiscordVoxSession } from "../src/vox-gateway.ts";
import { FakeVox } from "./fake-vox.ts";

const GUILD_A = "222222222222222222";
const GUILD_B = "333333333333333333";
const CHANNEL_A = "444444444444444444";
const CHANNEL_B = "555555555555555555";

class FakeGuild implements DiscordVoxGuild {
  public readonly id: string;
  public callbacks: InternalDiscordGatewayAdapterLibraryMethods | undefined;
  public readonly sent: unknown[] = [];
  public readonly destroyCallsAtSend: number[] = [];
  public sendPayloadResult = true;
  public destroyCalls = 0;

  public constructor(id: string) {
    this.id = id;
  }

  public readonly voiceAdapterCreator: InternalDiscordGatewayAdapterCreator = (callbacks) => {
    this.callbacks = callbacks;
    return {
      sendPayload: (payload) => {
        this.destroyCallsAtSend.push(this.destroyCalls);
        this.sent.push(payload);
        return this.sendPayloadResult;
      },
      destroy: () => {
        this.destroyCalls += 1;
      },
    };
  };

  public emitVoiceState(channelId: string | null): void {
    this.callbacks?.onVoiceStateUpdate({
      guild_id: this.id,
      channel_id: channelId,
      session_id: "session-1",
      user_id: "666666666666666666",
      deaf: false,
      mute: false,
      self_deaf: false,
      self_mute: false,
      self_stream: false,
      self_video: false,
      suppress: false,
      request_to_speak_timestamp: null,
    });
  }
}

class FakeSession implements DiscordVoxSession {
  private readonly vox: FakeVox;
  private connectionNumber = 0;
  public state: { active: boolean; guildId?: string; channelId?: string } = { active: false };
  public readonly leaveReasons: (string | undefined)[] = [];
  public leaveError: Error | undefined;

  public constructor(vox: FakeVox) {
    this.vox = vox;
  }

  public status() {
    return this.state;
  }

  public async join(input: { guildId: string; channelId: string }): Promise<{ daveProtocolVersion: number }> {
    this.state = { active: false, guildId: input.guildId, channelId: input.channelId };
    this.connectionNumber += 1;
    this.vox.joinVoice({ ...input, connectionId: `fake-connection-${String(this.connectionNumber)}` });
    await Promise.resolve();
    this.state = { active: true, guildId: input.guildId, channelId: input.channelId };
    return { daveProtocolVersion: 1 };
  }

  public async leave(reason?: string): Promise<void> {
    this.leaveReasons.push(reason);
    const wasActive = this.state.guildId !== undefined;
    this.state = { active: false };
    if (this.leaveError !== undefined) throw this.leaveError;
    if (wasActive) this.vox.leaveVoice(reason);
  }
}

describe("Discord Vox gateway bridge", () => {
  it("registers first and completes leave only after the gateway confirms the bot left", async () => {
    const vox = new FakeVox();
    const session = new FakeSession(vox);
    const guild = new FakeGuild(GUILD_A);
    const confirmations: { guildId: string; channelId: string }[] = [];
    const bridge = new DiscordVoxGatewayBridge(vox, session, {
      onLeaveConfirmed: (confirmation) => {
        confirmations.push(confirmation);
      },
    });

    await bridge.join(guild, { guildId: GUILD_A, channelId: CHANNEL_A });
    expect(guild.sent).toEqual([
      {
        op: 4,
        d: { guild_id: GUILD_A, channel_id: CHANNEL_A, self_mute: false, self_deaf: false },
      },
    ]);

    guild.callbacks?.onVoiceServerUpdate({ guild_id: GUILD_A, endpoint: null, token: "voice-token" });
    guild.emitVoiceState(CHANNEL_A);
    expect(vox.voiceServers).toEqual([{ endpoint: null, token: "voice-token" }]);
    expect(vox.voiceStates).toEqual([
      { session_id: "session-1", user_id: "666666666666666666", channel_id: CHANNEL_A },
    ]);

    const leaving = bridge.leave("test_leave");
    expect(guild.sent.at(-1)).toEqual({
      op: 4,
      d: { guild_id: GUILD_A, channel_id: null, self_mute: false, self_deaf: false },
    });
    expect(session.status().active).toBe(false);
    expect(guild.destroyCalls).toBe(0);

    guild.emitVoiceState(null);
    await leaving;
    expect(guild.destroyCalls).toBe(1);
    expect(confirmations).toEqual([{ guildId: GUILD_A, channelId: CHANNEL_A }]);
    bridge.dispose();
  });

  it("fails the join immediately when the shard refuses sendPayload", async () => {
    const vox = new FakeVox();
    const session = new FakeSession(vox);
    const guild = new FakeGuild(GUILD_A);
    guild.sendPayloadResult = false;
    const errors: string[] = [];
    const bridge = new DiscordVoxGatewayBridge(vox, session, { onError: (message) => errors.push(message) });

    await expect(bridge.join(guild, { guildId: GUILD_A, channelId: CHANNEL_A })).rejects.toThrow(
      "refused the OP4",
    );
    expect(session.status().active).toBe(false);
    expect(errors).toContain(`Discord shard refused the OP4 voice-state payload for guild ${GUILD_A}`);
    expect(guild.destroyCalls).toBe(1);
    bridge.dispose();
  });

  it("leaves and clears the adapter when discord.js reports shard destruction", async () => {
    const vox = new FakeVox();
    const session = new FakeSession(vox);
    const guild = new FakeGuild(GUILD_A);
    const bridge = new DiscordVoxGatewayBridge(vox, session);
    await bridge.join(guild, { guildId: GUILD_A, channelId: CHANNEL_A });

    guild.callbacks?.destroy();
    await Promise.resolve();
    await Promise.resolve();

    expect(session.status().active).toBe(false);
    expect(session.leaveReasons).toContain("gateway_adapter_failed");
    expect(guild.destroyCalls).toBe(1);
    bridge.dispose();
  });

  it("uses the still-live adapter when the sole Vox process exits unexpectedly", async () => {
    const vox = new FakeVox();
    const session = new FakeSession(vox);
    const guild = new FakeGuild(GUILD_A);
    const bridge = new DiscordVoxGatewayBridge(vox, session);
    await bridge.join(guild, { guildId: GUILD_A, channelId: CHANNEL_A });

    vox.emitStatus("error", "unexpected exit");
    await Promise.resolve();
    await Promise.resolve();

    expect(guild.destroyCallsAtSend.at(-1)).toBe(0);
    expect(guild.destroyCalls).toBe(1);
    expect(session.status().active).toBe(false);
    expect(session.leaveReasons).toContain("gateway_adapter_failed");
    expect(vox.status).toBe("error");
    bridge.dispose();
  });

  it("sends a validated fallback OP4 leave before removing the adapter", async () => {
    const vox = new FakeVox();
    const session = new FakeSession(vox);
    const guild = new FakeGuild(GUILD_A);
    const confirmations: string[] = [];
    const bridge = new DiscordVoxGatewayBridge(vox, session, {
      onLeaveConfirmed: ({ guildId }) => {
        confirmations.push(guildId);
      },
    });
    await bridge.join(guild, { guildId: GUILD_A, channelId: CHANNEL_A });

    vox.emitStatus("closed", "unexpected exit");
    await flush();

    expect(guild.sent.at(-1)).toEqual({
      op: 4,
      d: { guild_id: GUILD_A, channel_id: null, self_mute: false, self_deaf: false },
    });
    expect(confirmations).toEqual([]);
    bridge.dispose();
  });

  it("contains a refused fallback send without claiming a confirmed leave", async () => {
    const vox = new FakeVox();
    const session = new FakeSession(vox);
    const guild = new FakeGuild(GUILD_A);
    const errors: string[] = [];
    const confirmations: string[] = [];
    const bridge = new DiscordVoxGatewayBridge(vox, session, {
      onError: (message) => errors.push(message),
      onLeaveConfirmed: ({ guildId }) => {
        confirmations.push(guildId);
      },
    });
    await bridge.join(guild, { guildId: GUILD_A, channelId: CHANNEL_A });
    guild.sendPayloadResult = false;

    vox.emitStatus("error", "unexpected exit");
    await flush();

    expect(errors).toContain(`Discord shard refused the fallback OP4 voice-state leave for guild ${GUILD_A}`);
    expect(confirmations).toEqual([]);
    expect(guild.destroyCalls).toBe(1);
    bridge.dispose();
  });

  it("contains terminal local cleanup failure after clearing session state", async () => {
    const vox = new FakeVox();
    const session = new FakeSession(vox);
    const guild = new FakeGuild(GUILD_A);
    const errors: string[] = [];
    const bridge = new DiscordVoxGatewayBridge(vox, session, {
      onError: (message) => errors.push(message),
    });
    await bridge.join(guild, { guildId: GUILD_A, channelId: CHANNEL_A });
    session.leaveError = new Error("Vox is closed");

    vox.emitStatus("error", "unexpected exit");
    await flush();

    expect(session.status().active).toBe(false);
    expect(session.leaveReasons).toContain("gateway_adapter_failed");
    expect(errors).toContain("Discord voice session cleanup failed: Vox is closed");
    bridge.dispose();
  });

  it("sends the old leave before registering a rejoin in another guild", async () => {
    const vox = new FakeVox();
    const session = new FakeSession(vox);
    const first = new FakeGuild(GUILD_A);
    const second = new FakeGuild(GUILD_B);
    const bridge = new DiscordVoxGatewayBridge(vox, session);

    await bridge.join(first, { guildId: GUILD_A, channelId: CHANNEL_A });
    const rejoining = bridge.join(second, { guildId: GUILD_B, channelId: CHANNEL_B });
    first.emitVoiceState(null);
    await rejoining;

    expect(first.sent).toEqual([
      { op: 4, d: { guild_id: GUILD_A, channel_id: CHANNEL_A, self_mute: false, self_deaf: false } },
      { op: 4, d: { guild_id: GUILD_A, channel_id: null, self_mute: false, self_deaf: false } },
    ]);
    expect(second.sent).toEqual([
      { op: 4, d: { guild_id: GUILD_B, channel_id: CHANNEL_B, self_mute: false, self_deaf: false } },
    ]);
    expect(first.destroyCalls).toBe(1);
    const leaving = bridge.leave();
    second.emitVoiceState(null);
    await leaving;
    bridge.dispose();
  });

  it("keeps one adapter alive when Vox submits OP4 null until Discord confirms it", async () => {
    const vox = new FakeVox();
    const session = new FakeSession(vox);
    const guild = new FakeGuild(GUILD_A);
    const bridge = new DiscordVoxGatewayBridge(vox, session);
    await bridge.join(guild, { guildId: GUILD_A, channelId: CHANNEL_A });

    const first = bridge.leave("first_leave");
    const second = bridge.leave("second_leave");
    expect(second).toBe(first);
    expect(guild.destroyCalls).toBe(0);
    let settled = false;
    void first.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    guild.emitVoiceState(null);
    await Promise.all([first, second]);
    expect(guild.destroyCalls).toBe(1);
    bridge.dispose();
  });

  it("treats an external gateway null state as the authoritative leave", async () => {
    const vox = new FakeVox();
    const session = new FakeSession(vox);
    const guild = new FakeGuild(GUILD_A);
    const confirmations: string[] = [];
    const bridge = new DiscordVoxGatewayBridge(vox, session, {
      onLeaveConfirmed: ({ guildId, channelId }) => {
        confirmations.push(`${guildId}:${channelId}`);
      },
    });
    await bridge.join(guild, { guildId: GUILD_A, channelId: CHANNEL_A });

    guild.emitVoiceState(null);
    await flush();

    expect(session.status().active).toBe(false);
    expect(session.leaveReasons).toContain("discord_gateway_left");
    expect(confirmations).toEqual([`${GUILD_A}:${CHANNEL_A}`]);
    expect(guild.destroyCalls).toBe(1);
    bridge.dispose();
  });

  it("fails a leave that Discord never confirms without removing the live adapter", async () => {
    const vox = new FakeVox();
    const session = new FakeSession(vox);
    const guild = new FakeGuild(GUILD_A);
    const confirmations: string[] = [];
    const bridge = new DiscordVoxGatewayBridge(vox, session, {
      leaveTimeoutMs: 5,
      onLeaveConfirmed: ({ guildId }) => {
        confirmations.push(guildId);
      },
    });
    await bridge.join(guild, { guildId: GUILD_A, channelId: CHANNEL_A });

    await expect(bridge.leave("confirmation_timeout")).rejects.toThrow(
      "Discord did not confirm the bot voice-state leave before the timeout",
    );
    expect(guild.destroyCalls).toBe(0);
    expect(confirmations).toEqual([]);

    guild.emitVoiceState(null);
    await flush();
    expect(confirmations).toEqual([GUILD_A]);
    expect(guild.destroyCalls).toBe(1);
    bridge.dispose();
  });
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
