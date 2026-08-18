import { DiscordPresenceSession } from "@clankie/discord-presence-core";
import {
  DiscordPresenceSessionRecordSchema,
  resolveDiscordPresenceToolExposure,
  type DiscordPresencePhaseEvent,
} from "@clankie/interactive-environment";
import type { DiscordPresenceWrite } from "@clankie/protocol";
import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordBotPresenceRuntime, encodeReactionEmoji } from "../src/bot-presence-runtime.ts";

describe("Discord presence gateway session on bot transport", () => {
  it("removes act capability and emits degraded when the gateway disconnects mid-action", async () => {
    const events: DiscordPresencePhaseEvent[] = [];
    let finishAction: ((value: { id: string }) => void) | undefined;
    const post = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          finishAction = resolve;
        }),
    );
    const session = fixtureSession(events);
    await session.start();
    await session.gatewayReady();
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post, put: vi.fn(), delete: vi.fn(), patch: vi.fn() } as never,
    });

    const inFlight = runtime.execute(sessionWrite("first"), session.record);
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    await session.gatewayDisconnected();
    expect(session.record.phase).toBe("degraded");
    expect(resolveDiscordPresenceToolExposure(session.record, "discord_presence").presenceTools).toEqual([]);
    finishAction?.({ id: "message-first" });
    await expect(inFlight).resolves.toMatchObject({ messageId: "message-first" });
    await expect(runtime.execute(sessionWrite("second"), session.record)).rejects.toThrow(
      /discord_presence_action_unavailable_for_bot/,
    );
    expect(post).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({
      type: "discord.presence.session.phase_changed",
      data: { previousPhase: "present", phase: "degraded", reason: "gateway_disconnected" },
    });
  });
});

function fixtureSession(events: DiscordPresencePhaseEvent[]) {
  let id = 0;
  let now = 0;
  return new DiscordPresenceSession({
    sessionId: "discord:bot:fixture",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot",
    emit: (event) => {
      events.push(event);
    },
    idFactory: () => `phase-${String(++id)}`,
    clock: () => new Date(Date.UTC(2026, 6, 14, 18, 0, now++)),
  });
}

function sessionWrite(suffix: string): DiscordPresenceWrite {
  return {
    schemaVersion: 1,
    idempotencyKey: `write-${suffix}`,
    action: "discord.presence.send_message",
    identity: {
      missionId: "mission-1",
      correlationId: `correlation-${suffix}`,
      profileHash: "profile-1",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
    },
    payload: { kind: "send_message", channelId: "channel-1", content: suffix },
  };
}

describe("DiscordBotPresenceRuntime", () => {
  it("posts replies and reactions through the bot REST client", async () => {
    const post = vi.fn(async () => ({ id: "msg-out-1" }));
    const put = vi.fn(async () => undefined);
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post, put, delete: vi.fn(), patch: vi.fn() } as never,
    });

    const reply = await runtime.execute(
      write({
        action: "discord.presence.reply",
        content: "hi",
        payload: { kind: "reply", channelId: "ch-1", messageId: "msg-1", content: "hi" },
      }),
      presentSession,
    );
    expect(reply).toMatchObject({
      action: "discord.presence.reply",
      transportKind: "bot",
      messageId: "msg-out-1",
    });
    expect(post).toHaveBeenCalledOnce();

    await runtime.execute(
      write({
        action: "discord.presence.react",
        payload: { kind: "react", channelId: "ch-1", messageId: "msg-1", emoji: "👍" },
      }),
      presentSession,
    );
    expect(put).toHaveBeenCalledOnce();
  });

  /**
   * The words survive the picture. An unresolvable artifact used to throw out
   * of `execute`, which the ingress read as a failed turn — so a browsing turn
   * that had already written its answer landed in the room as silence, and the
   * room poked him until two more turns re-answered it.
   */
  it("posts the reply text when the picture cannot be resolved, instead of losing both", async () => {
    const post = vi.fn(async () => ({ id: "msg-out-2" }));
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post, put: vi.fn(), delete: vi.fn(), patch: vi.fn() } as never,
      resolveAttachment: () => Promise.reject(new Error("discord_presence_attachment_root_unavailable")),
    });

    const reply = await runtime.execute(
      write({
        action: "discord.presence.reply_with_media",
        content: "sonicfox took it",
        payload: {
          kind: "reply_with_media",
          channelId: "ch-1",
          messageId: "msg-1",
          content: "sonicfox took it",
          artifactRef: "sha256:" + "a".repeat(64) + ":browser/shot.png",
          filename: "shot.png",
        },
      }),
      presentSession,
    );

    expect(reply).toMatchObject({ transportKind: "bot", messageId: "msg-out-2" });
    const sent = post.mock.lastCall as unknown as [string, { body: { content: string }; files?: unknown }];
    expect(sent[1].body.content).toContain("sonicfox took it");
    expect(sent[1].body.content).toContain("couldn't get the image to upload");
    expect(sent[1].files).toBeUndefined();
  });

  it("launches an activity via an EMBEDDED_APPLICATION invite and never a user token", async () => {
    const post = vi.fn(async (route: string) =>
      route.includes("invites") ? { code: "abc123" } : { id: "msg-launch" },
    );
    const del = vi.fn(async () => undefined);
    // Stop reads live invites rather than trusting in-process state, because the
    // presence runtime is constructed fresh for every action.
    const get = vi.fn(async () => [
      { code: "abc123", target_type: 2, target_application: { id: "app-123" } },
      { code: "unrelated", target_type: 0 },
      { code: "other-app", target_type: 2, target_application: { id: "app-999" } },
    ]);
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post, put: vi.fn(), delete: del, patch: vi.fn(), get } as never,
      activityApplicationIds: { gba_emulator: "app-123" },
    });

    const started = await runtime.execute(
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
    );

    // target_type 2 is the documented embedded-application invite; no selfbot transport.
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("voice-1"),
      expect.objectContaining({
        body: expect.objectContaining({ target_type: 2, target_application_id: "app-123" }),
      }),
    );
    expect(started).toMatchObject({ action: "discord.presence.activity_start", transportKind: "bot" });
    // Starting must not revoke the link it just minted.
    expect(del).not.toHaveBeenCalledWith(expect.stringContaining("abc123"));

    // Stopping revokes the invite so the surface is no longer launchable.
    await runtime.execute(
      write({
        action: "discord.presence.activity_stop",
        payload: { kind: "activity_stop", guildId: "guild-1", channelId: "voice-1" },
      }),
      DiscordPresenceSessionRecordSchema.parse({
        ...voiceSession,
        activityInstances: [
          {
            schemaVersion: 1,
            guildId: "guild-1",
            channelId: "voice-1",
            surface: "gba_emulator",
            startedAt: "2026-07-25T18:00:00.000Z",
          },
        ],
      }),
    );
    expect(del).toHaveBeenCalledWith(expect.stringContaining("abc123"));
    // Only our configured surface is revoked — never someone else's invite.
    expect(del).not.toHaveBeenCalledWith(expect.stringContaining("unrelated"));
    expect(del).not.toHaveBeenCalledWith(expect.stringContaining("other-app"));
  });

  it("refuses to launch a surface that is not configured", async () => {
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() } as never,
      // Deny-by-default: no surface configured at all.
    });
    await expect(
      runtime.execute(
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
    ).rejects.toThrow(/activity_surface_not_configured/);
  });

  it("starts a public thread without messageId using type PublicThread", async () => {
    const post = vi.fn(async () => ({ id: "thread-1" }));
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post, put: vi.fn(), delete: vi.fn(), patch: vi.fn() } as never,
    });
    await runtime.execute(
      write({
        action: "discord.presence.create_thread",
        payload: { kind: "create_thread", channelId: "ch-1", name: "mission-thread" },
      }),
      presentSession,
    );
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("ch-1"),
      expect.objectContaining({
        body: expect.objectContaining({
          name: "mission-thread",
          type: ChannelType.PublicThread,
        }),
      }),
    );
  });

  it("sends attachments via rest files[] without passThroughBody casts", async () => {
    const post = vi.fn(async () => ({ id: "msg-attach" }));
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post, put: vi.fn(), delete: vi.fn(), patch: vi.fn() } as never,
      resolveAttachment: async () => ({ data: Buffer.from("png"), contentType: "image/png" }),
    });
    // send_attachment is publish-external (policy) but the executor still accepts a
    // policy-allowed write; attachment resolver proves the REST shape.
    await expect(
      runtime.execute(
        write({
          action: "discord.presence.send_attachment",
          payload: {
            kind: "send_attachment",
            channelId: "ch-1",
            artifactRef: "artifact:1",
            filename: "shot.png",
          },
        }),
        presentSession,
      ),
    ).resolves.toMatchObject({ messageId: "msg-attach" });
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        files: [expect.objectContaining({ name: "shot.png", contentType: "image/png" })],
      }),
    );
    expect(JSON.stringify(post.mock.calls)).not.toContain("passThroughBody");
  });

  it("rejects Go Live on bot transport under the projected present session", async () => {
    const runtime = new DiscordBotPresenceRuntime({
      botToken: "bot-token",
      rest: { post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() } as never,
    });
    await expect(
      runtime.execute(
        write({
          action: "discord.presence.go_live_start",
          payload: { kind: "go_live_start", guildId: "g1", channelId: "v1" },
        }),
        presentSession,
      ),
    ).rejects.toThrow(/discord_presence_action_unavailable_for_bot/);
  });

  it("refuses construction without a bot token", () => {
    expect(() => new DiscordBotPresenceRuntime({ botToken: "  " })).toThrow(
      /discord_presence_bot_token_required/,
    );
  });
});

describe("encodeReactionEmoji", () => {
  it("encodes unicode, custom name:id, and angle-bracket mentions", () => {
    expect(encodeReactionEmoji("👍")).toBe(encodeURIComponent("👍"));
    expect(encodeReactionEmoji("clankie:123456789012345678")).toBe("clankie:123456789012345678");
    expect(encodeReactionEmoji("<:clankie:123456789012345678>")).toBe("clankie:123456789012345678");
    expect(encodeReactionEmoji("<a:wave:99>")).toBe("wave:99");
  });

  it("rejects malformed colon-bearing strings", () => {
    expect(() => encodeReactionEmoji("<:bad>")).toThrow(/discord_presence_invalid_emoji/);
    expect(() => encodeReactionEmoji("not:a:valid:emoji")).toThrow(/discord_presence_invalid_emoji/);
  });
});

const voiceSession = DiscordPresenceSessionRecordSchema.parse({
  schemaVersion: 1,
  sessionId: "discord:bot:fixture",
  characterId: "clankie",
  credentialRef: "broker:discord_bot:lab",
  transportKind: "bot",
  phase: "voice_active",
  gatewayConnected: true,
  voiceGuildIds: ["guild-1"],
  revision: 1,
  updatedAt: "2026-07-14T18:00:00.000Z",
});

function write(
  partial: Pick<DiscordPresenceWrite, "action" | "payload"> & Partial<Pick<DiscordPresenceWrite, "content">>,
): DiscordPresenceWrite {
  return {
    schemaVersion: 1,
    idempotencyKey: `id-${partial.action}`,
    identity: {
      missionId: "mission-1",
      correlationId: "corr-1",
      profileHash: "profile-1",
      characterId: "clankie",
      credentialRef: "broker:discord_bot:lab",
      transportKind: "bot",
    },
    ...partial,
  };
}

const presentSession = DiscordPresenceSessionRecordSchema.parse({
  schemaVersion: 1,
  sessionId: "discord:bot:fixture",
  characterId: "clankie",
  credentialRef: "broker:discord_bot:lab",
  transportKind: "bot",
  phase: "present",
  gatewayConnected: true,
  voiceGuildIds: [],
  revision: 1,
  updatedAt: "2026-07-14T18:00:00.000Z",
});
