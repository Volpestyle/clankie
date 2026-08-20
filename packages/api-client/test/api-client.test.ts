import { describe, expect, it, vi } from "vitest";
import { ClankieApiClient } from "../src/index.ts";

describe("ClankieApiClient live surface", () => {
  it("authenticates and validates Discord presence phase events", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:4310/v1/discord/presence-session-events");
      expect(init?.headers).toMatchObject({ authorization: "Bearer captain-secret" });
      const event = JSON.parse(String(init?.body)) as { data: { session: unknown } };
      return Response.json({ accepted: true, session: event.data.session });
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      captainToken: "captain-secret",
    });
    const session = {
      schemaVersion: 1 as const,
      sessionId: "discord:bot:fixture",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot" as const,
      phase: "present" as const,
      gatewayConnected: true,
      voiceGuildIds: [],
      activityInstances: [],
      revision: 2,
      updatedAt: "2026-07-14T18:00:02.000Z",
    };
    await expect(
      client.recordDiscordPresencePhase({
        schemaVersion: 1,
        plane: "semantic",
        id: "phase-2",
        type: "discord.presence.session.phase_changed",
        occurredAt: "2026-07-14T18:00:02.000Z",
        correlationId: "discord:bot:fixture",
        sessionId: "discord:bot:fixture",
        data: {
          previousPhase: "connecting",
          phase: "present",
          reason: "gateway_ready",
          session,
        },
      }),
    ).resolves.toEqual({ accepted: true, session });
  });

  it("authenticates bounded Discord presence channel turns", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:4310/v1/captain/channel-turns");
      expect(init?.headers).toMatchObject({ authorization: "Bearer captain-secret" });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        deliveryId: "message-1",
        identity: { presenceSessionId: "discord:dm:dm-1" },
        trigger: { kind: "dm", body: "hello" },
      });
      return Response.json({
        state: "settled",
        captainSessionId: "eve-session-1",
        turnId: "turn-1",
        response: "Hi there.",
      });
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      captainToken: "captain-secret",
    });

    await expect(
      client.submitDiscordCaptainChannelTurn({
        schemaVersion: 1,
        deliveryId: "message-1",
        identity: {
          presenceSessionId: "discord:dm:dm-1",
          correlationId: "discord-message:message-1",
          profileHash: "profile-1",
          characterId: "clankie",
          credentialRef: "discord_bot",
          transportKind: "bot",
        },
        trigger: { kind: "dm", id: "message-1", channelId: "dm-1", actorId: "james", body: "hello" },
        contextMessages: [],
      }),
    ).resolves.toMatchObject({ state: "settled", response: "Hi there." });
  });

  it("authenticates presence actions with the bridge's live session claim", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:4310/v1/discord/presence-actions");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer captain-secret",
        "x-clankie-discord-presence-phase": "present",
        "x-clankie-discord-presence-revision": "2",
        "x-clankie-discord-presence-session": "discord:bot:fixture",
      });
      return Response.json({
        id: "message-1:reply",
        action: "discord.presence.reply",
        transportKind: "bot",
        channelId: "dm-1",
        messageId: "reply-1",
      });
    });
    const client = new ClankieApiClient({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl,
      captainToken: "captain-secret",
    });

    await expect(
      client.executeDiscordPresenceAction(
        {
          schemaVersion: 1,
          idempotencyKey: "message-1:reply",
          action: "discord.presence.reply",
          identity: {
            presenceSessionId: "discord:dm:dm-1",
            correlationId: "discord-message:message-1",
            profileHash: "profile-1",
            characterId: "clankie",
            credentialRef: "discord_bot",
            transportKind: "bot",
          },
          content: "Hi there.",
          payload: {
            kind: "reply",
            channelId: "dm-1",
            messageId: "message-1",
            content: "Hi there.",
          },
        },
        {
          schemaVersion: 1,
          sessionId: "discord:bot:fixture",
          phase: "present",
          revision: 2,
        },
      ),
    ).resolves.toMatchObject({ messageId: "reply-1" });
  });

  it("fills a missing health profileHash with the unversioned constant", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true, service: "clankie" }));
    const client = new ClankieApiClient({ baseUrl: "http://127.0.0.1:4310", fetchImpl });
    await expect(client.getHealth()).resolves.toEqual({
      ok: true,
      service: "clankie",
      profileHash: "unversioned",
    });
  });

  it("fails before a request when no matching token is configured", () => {
    const client = new ClankieApiClient({ baseUrl: "http://127.0.0.1:4310", fetchImpl: vi.fn() });
    expect(() => client.inspectDiscordReadiness()).toThrow("CLANKIE_CAPTAIN_TOKEN");
    expect(() => client.inspectMemory()).toThrow("CLANKIE_OPERATOR_TOKEN");
  });

  it("authenticates and validates current activity reads for captain or operator", async () => {
    const credentials: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:4310/v1/embodiment/sessions/live/activity");
      const headers = init?.headers as Record<string, string> | undefined;
      credentials.push(headers?.authorization ?? "");
      return Response.json({ schemaVersion: 1, outcome: "not_playing" });
    });

    await expect(
      new ClankieApiClient({
        baseUrl: "http://127.0.0.1:4310",
        fetchImpl,
        captainToken: "captain-secret",
        operatorToken: "operator-secret",
      }).getCurrentActivityObservation(),
    ).resolves.toEqual({ schemaVersion: 1, outcome: "not_playing" });
    await expect(
      new ClankieApiClient({
        baseUrl: "http://127.0.0.1:4310",
        fetchImpl,
        operatorToken: "operator-secret",
      }).getCurrentActivityObservation(),
    ).resolves.toEqual({ schemaVersion: 1, outcome: "not_playing" });

    expect(credentials).toEqual(["Bearer captain-secret", "Bearer operator-secret"]);
  });
});
