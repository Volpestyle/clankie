import { resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import type { DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";
import { EveCaptainChannelTurnPort } from "../src/eve-captain-turn.ts";

let doctrine: Awaited<ReturnType<typeof compileDoctrine>>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

describe("Discord channel control-plane runtime", () => {
  it("authenticates, deduplicates, and submits ambient Discord turns without Linear", async () => {
    let submissions = 0;
    const app = await createControlPlane({
      doctrine,
      authenticateCaptain: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer discord-captain"
            ? { captainId: "discord-bridge", steerSourceLane: "discord_text" }
            : undefined,
        ),
      captainChannelTurns: {
        async submit() {
          submissions += 1;
          return {
            state: "settled",
            captainSessionId: "captain-session",
            turnId: "turn-1",
            response: "Hello from Clankie.",
          };
        },
      },
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
    expect(duplicate.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(submissions).toBe(1);
  });

  it("opens the explicit discord_presence lane with turn-only untrusted context", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const port = new EveCaptainChannelTurnPort({
      baseUrl: "http://127.0.0.1:4321",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        });
        if (init?.method === "POST") {
          return Response.json(
            { sessionId: "eve-discord", continuationToken: "discord-token" },
            { status: 202 },
          );
        }
        return ndjson([
          { type: "turn.started", data: { turnId: "discord-turn-1" } },
          {
            type: "message.completed",
            data: { turnId: "discord-turn-1", finishReason: "stop", message: "Hello." },
          },
          { type: "session.waiting", data: { turnId: "discord-turn-1" } },
        ]);
      },
    });

    await expect(port.submit({ request: turnRequest() })).resolves.toMatchObject({
      state: "settled",
      turnId: "discord-turn-1",
      response: "Hello.",
    });
    await expect(
      port.submit({ request: { ...turnRequest(), deliveryId: "message-2" } }),
    ).resolves.toMatchObject({
      state: "settled",
    });
    expect(requests[0]?.body).toMatchObject({
      message: expect.stringContaining("ephemeral clientContext"),
      clientContext: {
        channel: {
          kind: "discord-text",
          authority: "ambient",
          channelId: "dm-1",
          actorId: "james",
          metadata: {
            captainLane: "discord_presence",
            captainTargetId: "dm:dm-1",
          },
        },
        identity: {
          presenceSessionId: "discord:dm:dm-1",
          correlationId: "discord-message:message-1",
        },
        thread: {
          source: "discord",
          retention: "turn_only",
          trigger: { id: "message-1", actorId: "james", body: "hello" },
          messages: [
            {
              id: "context-1",
              authorId: "friend",
              body: "earlier",
              createdAt: "2026-07-12T20:00:00.000Z",
            },
          ],
        },
      },
    });
    expect(requests[0]?.body).not.toMatchObject({ message: expect.stringContaining("hello") });
    expect(requests[2]).toMatchObject({ url: "http://127.0.0.1:4321/eve/v1/session" });
    expect(requests[2]?.body).not.toHaveProperty("continuationToken");
  });
});

function turnRequest(): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: "message-1",
    identity: {
      presenceSessionId: "discord:dm:dm-1",
      correlationId: "discord-message:message-1",
      profileHash: doctrine.profileHash,
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

async function post(
  app: Awaited<ReturnType<typeof createControlPlane>>,
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

function ndjson(events: readonly unknown[]): Response {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n"));
}
