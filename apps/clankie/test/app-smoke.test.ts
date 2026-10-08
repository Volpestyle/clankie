import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultOperatorAgentAppearance,
  HERDR_BINDING_PATH,
  HERDR_SOCKET_HEADER,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  ProcessHealthSnapshotSchema,
  type ObservableCaptainLane,
  type OperatorAgentPersona,
  type OperatorFleetSeat,
  type OperatorFleetSnapshot,
} from "@clankie/protocol";
import { ClankieSettingsSchema } from "@clankie/settings";
import { afterEach, describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { captainInstructions } from "../src/captain/captain.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { composeVoiceLaneInstructions } from "../src/captain/voice-lane.ts";
import { createFileMemory } from "../src/memory.ts";
import { VOICE_AWARENESS_MAX_CHARACTERS } from "../src/voice-awareness.ts";

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
  it("qualifies messages, worker stances and work assignments by their source session", async () => {
    for (const runtime of ["bundled", "external"] as const) {
      const received: unknown[] = [];
      const binding = { runtime, session: "default", socketPath: "/tmp/chosen.sock" };
      const clankie = await createClankieApp({
        herdrBinding: () => binding,
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
        for (const socket of [undefined, "/tmp/other.sock", binding.socketPath]) {
          const response = await clankie.app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(socket ? { [HERDR_SOCKET_HEADER]: socket } : {}),
            },
            body: JSON.stringify({
              op: "state_work",
              schemaVersion: 1,
              work: { herdrPaneId: "w1:p1", assignment: { objective: "Fix loading" } },
            }),
          });
          expect(response.status).toBe(socket === binding.socketPath ? 200 : 409);
        }
        expect(received).toHaveLength(2);
        expect(received[1]).toMatchObject({ op: "state_work", work: { herdrPaneId: "w1:p1" } });
        received.splice(1);
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
  it("reports optional runtime recovery without making the captain unhealthy", async () => {
    let state = "recovering";
    const clankie = await createClankieApp({ captain: createStubCaptain(), herdrRuntime: () => state });
    try {
      const recovering = await clankie.app.request("/health");
      expect(recovering.status).toBe(200);
      const body = await recovering.json();
      const processHealth = ProcessHealthSnapshotSchema.parse(body.processHealth);
      expect(processHealth.pid).toBe(process.pid);
      expect(body).toEqual({
        ok: true,
        service: "clankie",
        herdr: "recovering",
        processHealth,
      });
      state = "healthy";
      expect((await clankie.app.request("/health")).status).toBe(200);
    } finally {
      clankie.close();
    }
  });
  it("composes realtime voice as Clankie: identity, one register, and what he is up to", async () => {
    const at = "2026-10-05T03:00:00.000Z";
    const now = new Date("2026-10-05T03:13:00.000Z");
    const persona = (personaId: string, name: string): OperatorAgentPersona => ({
      schemaVersion: 1,
      personaId,
      name,
      appearance: defaultOperatorAgentAppearance("codex", personaId),
      harness: "codex",
      createdAt: at,
      updatedAt: at,
    });
    const seat = (index: number, status: string, objective?: string): OperatorFleetSeat => ({
      seatId: `seat-${String(index)}`,
      occupantId: `occupant-${String(index)}`,
      personaId: `persona-${String(index)}`,
      harness: "codex",
      status,
      title: `pane ${String(index)}`,
      ...(objective === undefined ? {} : { assignment: { objective, updatedAt: at } }),
    });
    const fleet: OperatorFleetSnapshot = {
      schemaVersion: 1,
      cursor: "c1",
      goals: [
        {
          conversationId: "global-default",
          goal: { objective: "Land batch 12", status: "active", tokensUsed: 0, createdAt: at, updatedAt: at },
        },
      ],
      seats: [
        seat(1, "idle"),
        seat(2, "working", "Fix the voice register"),
        ...[3, 4, 5, 6, 7, 8].map((index) => seat(index, "idle")),
      ],
      personas: [persona("persona-1", "Bram"), persona("persona-2", "Kit")],
      channels: [],
    };
    const lanes: ObservableCaptainLane[] = [
      {
        lane: "discord_presence",
        targetId: "12345:111",
        entries: [
          { at, kind: "heard", text: "whitelist thinkcreate2" },
          { at, kind: "said", text: "we cookin, server's back up" },
        ],
      },
      {
        lane: "discord_presence",
        targetId: "99999:222",
        entries: [{ at, kind: "heard", text: "OTHER_GUILD" }],
      },
      {
        lane: "operator",
        targetId: "global-default",
        entries: [{ at, kind: "heard", text: "CONSOLE_PRIVATE" }],
      },
    ];
    const compose = async (captain: Parameters<typeof createStubCaptain>[0], ownerRoom = true) => {
      const clankie = await createClankieApp({
        captain: createStubCaptain({
          voiceLaneInstructions: () => composeVoiceLaneInstructions(captainInstructions()),
          ...captain,
        }),
        clock: () => now,
        settings: {
          load: async () =>
            ClankieSettingsSchema.parse({
              schemaVersion: 1,
              discord: {
                servers: [{ serverId: "12345", owners: ownerRoom ? "everyone" : "me" }],
              },
            }),
        },
        discordPresenceRuntime: {
          execute: async () => {
            throw new Error("briefing must not write");
          },
          serverAction: async () => ({
            ok: true,
            message: "Channel metadata",
            data: { id: "67890", guild_id: "12345", permission_overwrites: [] },
          }),
        },
        authenticateCaptain: (request) =>
          Promise.resolve(
            request.headers.get("authorization") === "Bearer captain"
              ? { captainId: "captain-clankie", steerSourceLane: "discord_voice" as const }
              : undefined,
          ),
      });
      try {
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
        return ((await response.json()) as { instructions: string }).instructions;
      } finally {
        clankie.close();
      }
    };
    const count = (text: string, needle: string) => text.split(needle).length - 1;

    const instructions = await compose({
      serveOperatorConversation: async (request) =>
        request.op === "fleet" && request.includeWork === true
          ? { op: "fleet", schemaVersion: 1, snapshot: fleet }
          : Promise.reject(new Error(`unexpected ${request.op}`)),
      observeLanes: async () => lanes,
    });

    // The same Identity every lane gets, and only that section of instructions.md.
    expect(instructions).toContain("You are Clankie: a persistent agent with a life of your own.");
    expect(instructions).toContain("You are one Clankie across");
    expect(instructions).not.toContain("# Trust");
    // One voice is him: no front-end/back-end split.
    expect(instructions).toContain("This voice is you, Clankie");
    expect(instructions).toContain(
      "`ask_clankie` is how you think something through or act with your full tools",
    );
    expect(instructions).not.toContain("captain mind");
    expect(instructions).not.toContain("ask the captain");
    // Trust and routing rules survive.
    expect(instructions).toContain(
      "never tell someone you cannot do or see something before asking through it",
    );
    expect(instructions).toContain("treat that id as ground truth");
    expect(instructions).toContain("do not wait for someone to tell you to remember it");
    expect(instructions).toContain("part of your own experience or developing personality");
    // One length and register rule, stated once.
    expect(count(instructions, "Usually one short sentence, sometimes just a few words.")).toBe(1);
    expect(count(instructions, "menus of options")).toBe(1);
    expect(instructions).toContain("Don't end on a question unless you actually need the answer.");
    expect(instructions).toContain("give the gist in a sentence and offer the rest in text");
    expect(instructions).not.toContain("earn more room");
    expect(instructions).not.toContain("Match the length to the moment");
    // What he is up to: fleet, goal, and this guild's text room — never the console or another guild.
    const awareness = instructions.slice(instructions.indexOf("# What you're up to"));
    expect(instructions.indexOf("# What you're up to")).toBeGreaterThan(
      instructions.indexOf("# This surface"),
    );
    expect(awareness.length).toBeLessThanOrEqual(VOICE_AWARENESS_MAX_CHARACTERS);
    expect(awareness).toContain("- A goal you are working toward: Land batch 12");
    expect(awareness).toContain("- Agents in your fleet right now (8):");
    expect(awareness.indexOf("Kit, working: Fix the voice register")).toBeLessThan(
      awareness.indexOf("Bram, idle"),
    );
    expect(awareness).toContain("  - and 2 more");
    expect(awareness).toContain("- Last text chat in this server, 13 min ago");
    expect(awareness).toContain('You said: "we cookin, server\'s back up"');
    expect(awareness).not.toContain("OTHER_GUILD");
    expect(awareness).not.toContain("CONSOLE_PRIVATE");
    expect(instructions.length).toBeLessThanOrEqual(12_000);

    // A fleet that cannot be read, or a room read that hangs, leaves the call able to open.
    const degraded = await compose({ observeLanes: () => new Promise(() => undefined) });
    expect(degraded).toContain("- Your fleet could not be read just now; ask_clankie can check it.");
    expect(degraded).not.toContain("Last text chat");
    let privateReads = 0;
    const mixed = await compose(
      {
        serveOperatorConversation: async () => {
          privateReads += 1;
          throw new Error("private fleet read");
        },
        observeLanes: async () => {
          privateReads += 1;
          return lanes;
        },
      },
      false,
    );
    expect(privateReads).toBe(0);
    expect(mixed).not.toContain("Land batch 12");
    expect(mixed).not.toContain("Fix the voice register");
    expect(mixed).not.toContain("we cookin");
    expect(mixed).toContain("even when an owner asks");
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
            ? {
                captainId: "captain-clankie",
                steerSourceLane: "discord_text" as const,
                episodeSource: {
                  conversationId: "room-smoke",
                  lane: "discord_presence" as const,
                  targetId: "dm:dm-1",
                  sessionId: "smoke-session",
                },
              }
            : undefined,
        ),
    });
    const { app } = clankie;
    const captain = { authorization: "Bearer captain", "content-type": "application/json" };

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      service: "clankie",
      processHealth: {
        schemaVersion: 1,
        pid: process.pid,
        cpu: { userMicros: expect.any(Number), systemMicros: expect.any(Number) },
      },
    });

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
