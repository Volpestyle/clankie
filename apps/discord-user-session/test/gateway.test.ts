import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import {
  DiscordUserGateway,
  type DiscordGatewayMessage,
  type DiscordGatewayVoiceServer,
} from "../src/gateway.ts";

describe("DiscordUserGateway", () => {
  it("identifies with a bare user token and no bot intents", () => {
    const socket = new FakeSocket();
    const gateway = new DiscordUserGateway({ token: "user-token", connect: () => socket.asWebSocket() });
    gateway.open();
    socket.deliver({ op: 10, d: { heartbeat_interval: 45_000 } });

    const identify = socket.sent.find((frame) => frame.op === 2);
    expect(identify?.d).toMatchObject({ token: "user-token", capabilities: 0 });
    // A user credential is presented bare; `Bot ` or an intents bitfield would
    // be rejected by Discord for this account type.
    expect(JSON.stringify(identify)).not.toContain("Bot ");
    expect(identify?.d).not.toHaveProperty("intents");
    gateway.close();
  });

  it("surfaces ready identity, messages, and voice server updates", () => {
    const socket = new FakeSocket();
    const gateway = new DiscordUserGateway({ token: "user-token", connect: () => socket.asWebSocket() });
    const messages: DiscordGatewayMessage[] = [];
    const servers: DiscordGatewayVoiceServer[] = [];
    let readyId: string | undefined;
    gateway.on("ready", (identity) => (readyId = identity.userId));
    gateway.on("messageCreate", (message) => messages.push(message));
    gateway.on("voiceServerUpdate", (server) => servers.push(server));

    gateway.open();
    socket.deliver({ op: 10, d: { heartbeat_interval: 45_000 } });
    socket.deliver({
      op: 0,
      s: 1,
      t: "READY",
      d: { session_id: "session-1", user: { id: "self-1", username: "clankie" } },
    });
    expect(readyId).toBe("self-1");
    expect(gateway.userId).toBe("self-1");

    socket.deliver({
      op: 0,
      s: 2,
      t: "MESSAGE_CREATE",
      d: {
        id: "message-1",
        guild_id: "guild-1",
        channel_id: "channel-1",
        content: "hey clankie",
        author: { id: "human-1" },
        mentions: [{ id: "self-1" }],
        embeds: [
          {
            type: "gifv",
            url: "https://klipy.com/gifs/greetings-PSr",
            thumbnail: {
              url: "https://static.klipy.com/greeting.webp",
              proxy_url: "https://images-ext-1.discordapp.net/external/greeting.webp",
            },
            video: {
              url: "https://static.klipy.com/greeting.mp4",
              proxy_url: "https://images-ext-1.discordapp.net/external/greeting.mp4",
            },
          },
        ],
      },
    });
    expect(messages).toEqual([
      {
        id: "message-1",
        guildId: "guild-1",
        channelId: "channel-1",
        authorId: "human-1",
        authorIsBot: false,
        mentionsSelf: true,
        content: "hey clankie",
        attachments: [],
        embeds: [
          {
            type: "gifv",
            url: "https://klipy.com/gifs/greetings-PSr",
            thumbnailUrl: "https://static.klipy.com/greeting.webp",
            thumbnailProxyUrl: "https://images-ext-1.discordapp.net/external/greeting.webp",
            videoUrl: "https://static.klipy.com/greeting.mp4",
            videoProxyUrl: "https://images-ext-1.discordapp.net/external/greeting.mp4",
          },
        ],
      },
    ]);

    socket.deliver({
      op: 0,
      s: 3,
      t: "VOICE_SERVER_UPDATE",
      d: { guild_id: "guild-1", token: "voice-token", endpoint: "voice.discord.gg" },
    });
    expect(servers).toEqual([{ guildId: "guild-1", token: "voice-token", endpoint: "voice.discord.gg" }]);

    const raw: string[] = [];
    gateway.on("raw", (packet) => raw.push(packet.t));
    socket.deliver({
      op: 0,
      s: 4,
      t: "STREAM_CREATE",
      d: { stream_key: "guild:guild-1:voice-1:human-1" },
    });
    expect(raw).toContain("STREAM_CREATE");
    gateway.close();
  });

  it("resumes with the retained session instead of re-identifying", () => {
    const sockets: FakeSocket[] = [];
    const gateway = new DiscordUserGateway({
      token: "user-token",
      connect: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket.asWebSocket();
      },
    });
    gateway.open();
    sockets[0]?.deliver({ op: 10, d: { heartbeat_interval: 45_000 } });
    sockets[0]?.deliver({
      op: 0,
      s: 7,
      t: "READY",
      d: { session_id: "session-1", user: { id: "self-1", username: "clankie" } },
    });

    // Op 7 RECONNECT: a fresh identify would drop queued events and burn a
    // login; resume is what keeps the conversation continuous.
    sockets[0]?.deliver({ op: 7 });
    expect(sockets[0]?.closedWith).toBe(4_000);
    gateway.close();
  });

  it("treats an authentication failure as terminal rather than retrying", () => {
    const socket = new FakeSocket();
    const failures: string[] = [];
    const gateway = new DiscordUserGateway({ token: "user-token", connect: () => socket.asWebSocket() });
    gateway.on("failed", (reason) => failures.push(reason));
    gateway.open();
    // Hammering identify with a bad credential is precisely what gets an
    // account flagged, so 4004 must stop the ladder.
    socket.close(4_004);
    expect(failures).toEqual(["discord_user_session_authentication_failed"]);
    gateway.close();
  });

  it("sends voice state updates as op 4", () => {
    const socket = new FakeSocket();
    const gateway = new DiscordUserGateway({ token: "user-token", connect: () => socket.asWebSocket() });
    gateway.open();
    socket.readyState = 1;
    gateway.sendVoiceStateUpdate({
      guildId: "guild-1",
      channelId: "voice-1",
      selfMute: false,
      selfDeaf: false,
    });
    expect(socket.sent.at(-1)).toEqual({
      op: 4,
      d: { guild_id: "guild-1", channel_id: "voice-1", self_mute: false, self_deaf: false },
    });
    gateway.close();
  });

  it("tracks current member voice channels from gateway state", () => {
    const socket = new FakeSocket();
    const gateway = new DiscordUserGateway({ token: "user-token", connect: () => socket.asWebSocket() });
    gateway.open();
    socket.deliver({ op: 10, d: { heartbeat_interval: 45_000 } });
    socket.deliver({
      op: 0,
      s: 1,
      t: "GUILD_CREATE",
      d: { id: "guild-1", voice_states: [{ user_id: "human-1", channel_id: "voice-1" }] },
    });
    expect(gateway.voiceChannelFor("guild-1", "human-1")).toBe("voice-1");

    socket.deliver({
      op: 0,
      s: 2,
      t: "VOICE_STATE_UPDATE",
      d: { guild_id: "guild-1", user_id: "human-1", channel_id: "voice-2" },
    });
    expect(gateway.voiceChannelFor("guild-1", "human-1")).toBe("voice-2");
    socket.deliver({
      op: 0,
      s: 3,
      t: "VOICE_STATE_UPDATE",
      d: { guild_id: "guild-1", user_id: "human-1", channel_id: null },
    });
    expect(gateway.voiceChannelFor("guild-1", "human-1")).toBeUndefined();
    gateway.close();
  });
});

interface Frame {
  op?: number;
  d?: unknown;
  s?: number;
  t?: string;
}

class FakeSocket extends EventEmitter {
  public readonly sent: Frame[] = [];
  public readyState = 1;
  public closedWith: number | undefined;

  public send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Frame);
  }

  public close(code: number): void {
    this.closedWith = code;
    this.readyState = 3;
    this.emit("close", code);
  }

  public deliver(frame: Frame): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }

  public asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}
