import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_CONVERSATION_DISPATCH_PATH } from "@clankie/protocol";
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
              : (() => {
                  throw new Error(`smoke stub only lists (got ${request.op})`);
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

    const unauthenticated = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "list", schemaVersion: 1 }),
    });
    expect(unauthenticated.status).toBe(401);

    clankie.close();
  });
});
