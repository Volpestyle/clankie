import { DiscordPresenceSessionRecordSchema } from "@clankie/interactive-environment";
import type { DiscordPresenceWrite } from "@clankie/protocol";
import { describe, expect, it, vi } from "vitest";
import { DiscordUserPresenceRuntime } from "../src/user-presence-runtime.ts";

describe("DiscordUserPresenceRuntime", () => {
  it("renders tool activity as a blockquote fallback", async () => {
    const fetchImpl = jsonFetch({ id: "tool-card-1" });
    const result = await runtime(fetchImpl).execute(
      write({
        action: "discord.presence.tool_progress",
        payload: {
          kind: "tool_progress",
          channelId: "channel-1",
          replyToMessageId: "message-1",
          phase: "running",
          categories: ["working_locally"],
          toolCalls: 2,
          activeToolCalls: 1,
          failedToolCalls: 0,
          elapsedSeconds: 3,
        },
      }),
      present,
    );
    expect(result.messageId).toBe("tool-card-1");
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      content: expect.stringMatching(/^> 🛠️ \*\*Tool activity\*\*/u),
      allowed_mentions: { parse: [] },
    });
  });

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

  it("starts Go Live through the lab process control port, including a source URL", async () => {
    const goLiveSession = DiscordPresenceSessionRecordSchema.parse({
      ...present,
      phase: "voice_active",
      voiceGuildIds: ["guild-1"],
    });
    const controlFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 202 })),
    ) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
    const withControl = new DiscordUserPresenceRuntime({
      token: "user-token",
      fetch: jsonFetch({}),
      controlFetch,
    });
    await expect(
      withControl.execute(
        write({
          action: "discord.presence.go_live_start",
          payload: {
            kind: "go_live_start",
            guildId: "guild-1",
            channelId: "voice-1",
            sourceUrl: "https://example.com/clip.mp4",
          },
        }),
        goLiveSession,
      ),
    ).resolves.toMatchObject({ action: "discord.presence.go_live_start", transportKind: "user_session" });
    const [url, init] = controlFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4312/go-live/start");
    expect(JSON.parse(String(init.body))).toEqual({
      guildId: "guild-1",
      channelId: "voice-1",
      sourceUrl: "https://example.com/clip.mp4",
    });
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

  it("propagates a Go Live stop refusal from the lab process", async () => {
    const goLiveSession = DiscordPresenceSessionRecordSchema.parse({
      ...present,
      phase: "voice_active",
      voiceGuildIds: ["guild-1"],
    });
    const withControl = new DiscordUserPresenceRuntime({
      token: "user-token",
      fetch: jsonFetch({}),
      controlFetch: vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
    });
    await expect(
      withControl.execute(
        write({
          action: "discord.presence.go_live_stop",
          payload: { kind: "go_live_stop", guildId: "guild-1" },
        }),
        goLiveSession,
      ),
    ).rejects.toThrow(/user_session_control_503/u);
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
