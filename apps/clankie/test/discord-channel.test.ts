import type { DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

/**
 * The route half of the old discord-channel suite. The Eve turn port's own
 * composition tests left with `eve-captain-turn.ts`; the pi captain behind
 * `CaptainPort` owns that seam now and carries its own tests when it lands.
 */
describe("Discord channel turn routes", () => {
  it("authenticates, deduplicates, and submits ambient Discord turns", async () => {
    let submissions = 0;
    const { app } = await createClankieApp({
      captain: createStubCaptain({
        submitDiscordTurn: async () => {
          submissions += 1;
          return {
            state: "settled",
            captainSessionId: "captain-session",
            turnId: "turn-1",
            response: "Hello from Clankie.",
          };
        },
      }),
      authenticateCaptain: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer discord-captain"
            ? { captainId: "discord-bridge", steerSourceLane: "discord_text" }
            : undefined,
        ),
    });
    const request = turnRequest();

    const unauthenticated = await post(app, request);
    const first = await post(app, request, "Bearer discord-captain");
    const duplicate = await post(app, request, "Bearer discord-captain");
    const conflict = await post(
      app,
      { ...request, trigger: { ...request.trigger, body: "different" } },
      "Bearer discord-captain",
    );

    expect(unauthenticated.status).toBe(401);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ state: "settled", response: "Hello from Clankie." });
    expect(duplicate.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(submissions).toBe(1);
  });

  it("admits voice only from a Discord voice bridge identity and preserves text authority", async () => {
    const submitted: DiscordPresenceChannelTurnRequest[] = [];
    const { app } = await createClankieApp({
      captain: createStubCaptain({
        submitDiscordTurn: async (request) => {
          submitted.push(request);
          return {
            state: "settled",
            captainSessionId: "captain-session",
            turnId: "turn-voice",
            response: "Voice reply.",
          };
        },
      }),
      authenticateCaptain: () =>
        Promise.resolve({ captainId: "discord-voice-bridge", steerSourceLane: "discord_voice" }),
    });

    const voice = await post(app, voiceTurnRequest(), "Bearer voice");
    const text = await post(app, turnRequest(), "Bearer voice");
    expect(voice.status).toBe(200);
    expect(text.status).toBe(403);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.trigger).toMatchObject({ kind: "voice_event", actorId: "user-1" });
  });

  it("answers 502 on a failed turn and lets the same delivery retry", async () => {
    let calls = 0;
    const { app } = await createClankieApp({
      captain: createStubCaptain({
        submitDiscordTurn: async () => {
          calls += 1;
          if (calls === 1) throw new Error("model unavailable");
          return {
            state: "settled",
            captainSessionId: "captain-session",
            turnId: "turn-retry",
            response: "Second try.",
          };
        },
      }),
      authenticateCaptain: () =>
        Promise.resolve({ captainId: "discord-bridge", steerSourceLane: "discord_text" }),
    });
    const failed = await post(app, turnRequest(), "Bearer discord-captain");
    expect(failed.status).toBe(502);
    const retried = await post(app, turnRequest(), "Bearer discord-captain");
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({ response: "Second try." });
  });
});

function turnRequest(): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: "message-1",
    identity: {
      presenceSessionId: "discord:dm:dm-1",
      correlationId: "discord-message:message-1",
      profileHash: "unversioned",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
    },
    trigger: {
      kind: "dm",
      id: "message-1",
      channelId: "dm-1",
      messageId: "message-1",
      actorId: "james",
      body: "hello",
      attachments: [],
    },
    contextMessages: [
      {
        id: "context-1",
        authorId: "friend",
        body: "earlier",
        createdAt: "2026-07-12T20:00:00.000Z",
      },
    ],
  };
}

function voiceTurnRequest(): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: "utterance-1",
    identity: {
      presenceSessionId: "discord:voice:guild-1:voice-1",
      correlationId: "discord-voice:utterance-1",
      profileHash: "unversioned",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
    },
    trigger: {
      kind: "voice_event",
      id: "utterance-1",
      guildId: "guild-1",
      channelId: "voice-1",
      actorId: "user-1",
      body: "hello group",
      attachments: [],
    },
    contextMessages: [],
  };
}

describe("Discord channel projection route (ADR 0146)", () => {
  const message = {
    schemaVersion: 1 as const,
    deliveryId: "message-9",
    guildId: "guild-1",
    channelId: "discord-channel-1",
    body: "why is the atlas slow?",
  };
  const projectionApp = async (
    submit: (input: unknown) => Promise<{ state: "not_projected" } | { state: "accepted" }>,
  ) =>
    (await createClankieApp({
      captain: createStubCaptain({
        submitChannelProjectionMessage: async (request) => {
          const result = await submit(request);
          return result.state === "accepted"
            ? { schemaVersion: 1, state: "accepted", conversationId: "conv-1", runId: "run-1" }
            : { schemaVersion: 1, state: "not_projected" };
        },
      }),
      authenticateCaptain: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer discord-captain"
            ? { captainId: "discord-bridge", steerSourceLane: "discord_text" }
            : request.headers.get("authorization") === "Bearer voice"
              ? { captainId: "discord-voice", steerSourceLane: "discord_voice" }
              : undefined,
        ),
    })).app;

  const send = (app: Awaited<ReturnType<typeof createClankieApp>>["app"], authorization?: string) =>
    app.request("/v1/captain/channel-projection-messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify(message),
    });

  it("runs a projected channel's round once, however often the gateway redelivers", async () => {
    let submissions = 0;
    const app = await projectionApp(async () => {
      submissions += 1;
      return { state: "accepted" };
    });

    const first = await send(app, "Bearer discord-captain");
    const redelivered = await send(app, "Bearer discord-captain");

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      schemaVersion: 1,
      state: "accepted",
      conversationId: "conv-1",
      runId: "run-1",
    });
    await expect(redelivered.json()).resolves.toMatchObject({ state: "accepted" });
    // A round costs a model call per member, so a redelivery must never run one.
    expect(submissions).toBe(1);
  });

  it("hands a message back when nothing is projected there, leaving ordinary ingress alone", async () => {
    const app = await projectionApp(async () => ({ state: "not_projected" }));
    const response = await send(app, "Bearer discord-captain");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ schemaVersion: 1, state: "not_projected" });
  });

  it("admits only the authenticated text bridge", async () => {
    const app = await projectionApp(async () => ({ state: "accepted" }));
    expect((await send(app)).status).toBe(401);
    // Voice authority is not text authority, the same boundary channel turns hold.
    expect((await send(app, "Bearer voice")).status).toBe(403);
  });

  it("refuses a message with nothing in it", async () => {
    const app = await projectionApp(async () => ({ state: "accepted" }));
    const response = await app.request("/v1/captain/channel-projection-messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer discord-captain" },
      body: JSON.stringify({ ...message, body: "   " }),
    });
    expect(response.status).toBe(400);
  });
});

async function post(
  app: Awaited<ReturnType<typeof createClankieApp>>["app"],
  body: unknown,
  authorization?: string,
) {
  return app.request("/v1/captain/channel-turns", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  });
}
