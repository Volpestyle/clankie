import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HERDR_BINDING_PATH,
  HERDR_SOCKET_HEADER,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
} from "@clankie/protocol";
import { ClankieSettingsSchema } from "@clankie/settings";
import { afterEach, describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createFileMemory } from "../src/memory.ts";

/**
 * One boot-to-first-answer pass over the merged service: health, a Discord
 * channel turn through the stub captain, and an episode write plus recall —
 * temp dirs only, no model, no Discord.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("clankie app smoke", () => {
  it("does not interpret a client TUI's pane ID inside the private runtime", async () => {
    for (const bundled of [false, true]) {
      let receivedPane: string | undefined;
      const clankie = await createClankieApp({
        captain: createStubCaptain({
          serveOperatorConversation: async (request) => {
            if (request.op === "send") receivedPane = request.turn.herdrPaneId;
            return { op: "list", schemaVersion: 1, conversations: [] };
          },
        }),
        ...(bundled ? { herdrRuntime: () => "healthy" } : {}),
        authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
      });
      try {
        const response = await clankie.app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            op: "send",
            schemaVersion: 1,
            turn: {
              schemaVersion: 1,
              kind: "message",
              conversationId: "global-default",
              surfaceClientId: "tui",
              expectedRevision: 0,
              message: "hello",
              herdrPaneId: "w1:p1",
            },
          }),
        });
        expect(response.status).toBe(200);
        expect(receivedPane).toBe(bundled ? undefined : "w1:p1");
      } finally {
        clankie.close();
      }
    }
  });
  it("qualifies both messages and worker stances by their source session", async () => {
    for (const runtime of ["bundled", "external"] as const) {
      const received: unknown[] = [];
      const binding = { runtime, session: "default", socketPath: "/tmp/chosen.sock" };
      const clankie = await createClankieApp({
        herdrBinding: binding,
        captain: createStubCaptain({
          serveOperatorConversation: async (request) => {
            received.push(request);
            return { op: "list", schemaVersion: 1, conversations: [] };
          },
        }),
        authenticateOperator: async (request) =>
          request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
        authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
      });
      try {
        expect((await clankie.app.request(HERDR_BINDING_PATH)).status).toBe(401);
        const live = await clankie.app.request(HERDR_BINDING_PATH, {
          headers: { authorization: "Bearer owner" },
        });
        expect(await live.json()).toEqual(binding);
        for (const socket of [undefined, "/tmp/other.sock", binding.socketPath]) {
          const response = await clankie.app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(socket ? { [HERDR_SOCKET_HEADER]: socket } : {}),
            },
            body: JSON.stringify({
              op: "state_stance",
              schemaVersion: 1,
              stance: { herdrPaneId: "w1:p1", pose: "working" },
            }),
          });
          expect(response.status).toBe(socket === binding.socketPath ? 200 : 409);
        }
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ op: "state_stance", stance: { herdrPaneId: "w1:p1" } });
        for (const socket of ["/tmp/other.sock", binding.socketPath]) {
          await clankie.app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", [HERDR_SOCKET_HEADER]: socket },
            body: JSON.stringify({
              op: "send",
              schemaVersion: 1,
              turn: {
                schemaVersion: 1,
                kind: "message",
                conversationId: "global-default",
                surfaceClientId: "tui",
                expectedRevision: 0,
                message: "hi",
                herdrPaneId: "w1:p1",
              },
            }),
          });
        }
        expect(received[1]).toMatchObject({ turn: { message: "hi" } });
        expect((received[1] as { turn: { herdrPaneId?: string } }).turn.herdrPaneId).toBeUndefined();
        expect(received[2]).toMatchObject({ turn: { herdrPaneId: "w1:p1" } });
      } finally {
        clankie.close();
      }
    }
  });
  it("reports bundled runtime recovery through the public health endpoint", async () => {
    let state = "recovering";
    const clankie = await createClankieApp({ captain: createStubCaptain(), herdrRuntime: () => state });
    try {
      const recovering = await clankie.app.request("/health");
      expect(recovering.status).toBe(503);
      await expect(recovering.json()).resolves.toEqual({
        ok: false,
        service: "clankie",
        herdr: "recovering",
      });
      state = "healthy";
      expect((await clankie.app.request("/health")).status).toBe(200);
    } finally {
      clankie.close();
    }
  });
  it("gives realtime voice agency to initiate its own episodic memories", async () => {
    const clankie = await createClankieApp({
      captain: createStubCaptain(),
      settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
      authenticateCaptain: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer captain"
            ? { captainId: "captain-clankie", steerSourceLane: "discord_voice" as const }
            : undefined,
        ),
    });
    const response = await clankie.app.request("/v1/discord/voice-briefing", {
      method: "POST",
      headers: { authorization: "Bearer captain", "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        guildId: "12345",
        channelId: "67890",
        consentedUserIds: ["54321"],
      }),
    });

    expect(response.status).toBe(200);
    const briefing = (await response.json()) as { instructions: string };
    expect(briefing.instructions).toContain("do not wait for someone to tell you to remember it");
    expect(briefing.instructions).toContain("part of your own experience or developing personality");
    expect(briefing.instructions).toContain("your own captain mind");
    expect(briefing.instructions).toContain("web browsing and research");
    clankie.close();
  });

  it("boots with a stub captain and answers health, a channel turn, and episode recall", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-smoke-"));
    roots.push(root);
    const clankie = await createClankieApp({
      captain: createStubCaptain({
        serveOperatorConversation: (request) =>
          Promise.resolve(
            request.op === "list"
              ? { op: "list", schemaVersion: 1, conversations: [] }
              : request.op === "autonomy"
                ? { op: "autonomy", schemaVersion: 1, status: { enabled: true } }
                : (() => {
                    throw new Error(`smoke stub does not handle ${request.op}`);
                  })(),
          ),
      }),
      memory: createFileMemory({ dataDir: join(root, "memory") }),
      eventLogPath: join(root, "events.jsonl"),
      authenticateCaptain: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer captain"
            ? { captainId: "captain-clankie", steerSourceLane: "discord_text" as const }
            : undefined,
        ),
    });
    const { app } = clankie;
    const captain = { authorization: "Bearer captain", "content-type": "application/json" };

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true, service: "clankie" });

    const turn = await app.request("/v1/captain/channel-turns", {
      method: "POST",
      headers: captain,
      body: JSON.stringify({
        schemaVersion: 1,
        deliveryId: "smoke-message-1",
        identity: {
          presenceSessionId: "discord:dm:dm-1",
          correlationId: "discord-message:smoke-message-1",
          profileHash: "unversioned",
          characterId: "clankie",
          credentialRef: "discord_bot",
          transportKind: "bot",
        },
        trigger: {
          kind: "dm",
          id: "smoke-message-1",
          channelId: "dm-1",
          messageId: "smoke-message-1",
          actorId: "james",
          body: "hello",
          attachments: [],
        },
        contextMessages: [],
      }),
    });
    expect(turn.status).toBe(200);
    await expect(turn.json()).resolves.toMatchObject({ state: "settled", response: "stub response" });

    const wrote = await app.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: captain,
      body: JSON.stringify({
        schemaVersion: 1,
        episodeId: "smoke-episode-1",
        lane: "discord_presence",
        targetId: "dm:dm-1",
        summary: "Said hello to James in a DM.",
        visibility: "shareable",
        provenance: {
          characterId: "clankie",
          sessionId: "smoke-session",
          selfAuthored: true,
          rawTranscript: false,
        },
        occurredAt: "2026-08-12T12:00:00.000Z",
      }),
    });
    expect(wrote.status).toBe(200);
    await expect(wrote.json()).resolves.toEqual({ schemaVersion: 1, episodeId: "smoke-episode-1" });

    const recalled = await app.request("/v1/memory/captain-episodes?lane=discord_presence", {
      headers: captain,
    });
    expect(recalled.status).toBe(200);
    const card = (await recalled.json()) as { recallCard: string };
    expect(card.recallCard).toContain("Said hello to James");

    // The TUI and relay both reach the conversation contract with the shared
    // captain token; this route once checked the operator credential instead
    // and 401'd every real caller. Pin the fix.
    const dispatch = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: captain,
      body: JSON.stringify({ op: "list", schemaVersion: 1 }),
    });
    expect(dispatch.status).toBe(200);
    await expect(dispatch.json()).resolves.toMatchObject({ op: "list" });

    const autonomy = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: captain,
      body: JSON.stringify({
        op: "autonomy",
        schemaVersion: 1,
        conversationId: "global-default",
        command: { action: "status" },
      }),
    });
    expect(autonomy.status).toBe(200);
    await expect(autonomy.json()).resolves.toEqual({
      op: "autonomy",
      schemaVersion: 1,
      status: { enabled: true },
    });

    const unauthenticated = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "list", schemaVersion: 1 }),
    });
    expect(unauthenticated.status).toBe(401);

    clankie.close();
  });
});
