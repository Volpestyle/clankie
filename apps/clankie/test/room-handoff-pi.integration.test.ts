import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SettingsStore } from "@clankie/settings";
import {
  OperatorConversationServiceResultSchema,
  type DiscordPresenceChannelTurnRequest,
} from "@clankie/protocol";
import { expect, it, vi } from "vitest";
import { createCaptain } from "../src/captain/captain.ts";
import { createFileMemory } from "../src/memory.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { ConversationOwner } from "../src/captain/conversation-owner.ts";

// Select the loopback provider; Pi, its tools/extensions, sessions and journals remain real.
const selection = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../src/captain/model.ts", () => ({ createCaptainModelRuntime: async () => selection.value }));

function request(index: number): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: `delivery-${index}`,
    identity: {
      presenceSessionId: `body:${index === 5 ? "room-b" : "room-a"}`,
      correlationId: `correlation-${index}`,
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      profileHash: "fixture",
    },
    trigger: {
      kind: index === 5 ? "voice_event" : "message",
      id: `message-${index}`,
      guildId: "12345",
      channelId: index === 5 ? "99999" : "67890",
      actorId: `1000${index}`,
      body: "same request from a different delivery",
      attachments: [],
    },
    contextMessages: [],
  };
}

it("real Pi room children execute four at once, queue FIFO, retain source authority and survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-room-handoffs-"));
  const calls: {
    body: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
    response: ServerResponse;
    actor: string;
    finish: () => void;
  }[] = [];
  let active = 0;
  let draining = false;
  let peak = 0;
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as (typeof calls)[number]["body"];
    active += 1;
    peak = Math.max(peak, active);
    response.on("close", () => {
      active -= 1;
    });
    calls.push({
      body,
      response,
      actor:
        [...JSON.stringify(body.messages).matchAll(/Trigger message from <(1000[0-9])>/gu)].at(-1)?.[1] ??
        "unknown",
      finish: () => {
        if (response.writableEnded) return;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "local",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: `answer-${calls.find((call) => call.response === response)!.actor}`,
                },
                finish_reason: null,
              },
            ],
          })}\n\n` +
            `data: ${JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "local",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })}\n\ndata: [DONE]\n\n`,
        );
      },
    });
    if (draining) calls.at(-1)!.finish();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback address");
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("room-fixture", {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "fixture",
    models: [
      {
        id: "local",
        name: "local",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_000,
      },
    ],
  });
  selection.value = {
    runtime,
    resolveRoute: async () => ({
      selection: { model: runtime.getModel("room-fixture", "local")!, thinkingLevel: "off" },
    }),
  };
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, systemActorUserIds: ["10004"] },
  }));
  const memory = createFileMemory({ dataDir: join(root, "memory") });
  const owners: ConversationOwner[] = [];
  let routeCurrent = true;
  const deps = {
    herdrAvailable: () => false,
    embodiment: {},
    conversationRouteAuthorized: (owner: ConversationOwner) => {
      owners.push(owner);
      return routeCurrent;
    },
    memory: {
      recallEpisodeCard: async (lane: Parameters<typeof memory.episodeRecallCard>[0]["lane"]) =>
        memory.episodeRecallCard({ lane }),
      searchEpisodeCard: async () => "",
      recallDiscordPerson: () => "",
    },
    mcp: { catalog: async () => [] },
    browser: { catalog: async () => ({ available: false, tools: [] }) },
  } as unknown as CaptainDeps;
  const options = {
    repoRoot: root,
    stateDir: root,
    workingDirectory: root,
    settings,
    discordEnvironment: {},
    personaImages: async () => ({ images: [], hash: "fixture", files: [] }),
  };
  let captain = createCaptain(deps, options);
  let work: Promise<unknown>[] = [];
  try {
    work = Array.from({ length: 6 }, (_, index) => captain.submitDiscordTurn(request(index)));
    const retry = captain.submitDiscordTurn(request(0));
    await expect(
      captain.submitDiscordTurn({ ...request(0), trigger: { ...request(0).trigger, body: "conflict" } }),
    ).rejects.toThrow("room_handoff_delivery_conflict");
    await vi
      .waitFor(() => expect(calls).toHaveLength(4), { timeout: 10_000 })
      .catch(async (error) => {
        const snapshot = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
        if (snapshot.op === "fleet")
          console.error(snapshot.snapshot.roomHandoffs?.map((child) => child.roomHandoff));
        throw error;
      });
    const fleet = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    OperatorConversationServiceResultSchema.parse(fleet);
    if (fleet.op !== "fleet") throw new Error("Expected fleet");
    expect(fleet.snapshot.roomHandoffs).toHaveLength(6);
    expect(
      fleet.snapshot.roomHandoffs?.filter((child) => child.roomHandoff?.state === "running"),
    ).toHaveLength(4);
    expect(
      fleet.snapshot.roomHandoffs?.filter((child) => child.roomHandoff?.state === "pending"),
    ).toHaveLength(2);
    expect(fleet.snapshot.roomHandoffs?.every((child) => child.parentConversationId === undefined)).toBe(
      true,
    );
    // A grant revoked while waiting cannot become a shell bank when its child starts.
    await settings.update((current) => ({
      ...current,
      discord: { ...current.discord, systemActorUserIds: ["10005"] },
    }));
    calls.find((call) => call.actor === "10000")!.finish();
    expect(await work[0]).toMatchObject({ state: "settled", response: "answer-10000" });
    expect(await retry).toEqual(await work[0]);
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    expect(JSON.stringify(calls[4]!.body.messages)).toContain("Trigger message from <10004>");
    expect(calls[4]!.body.tools?.some((tool) => tool.function.name === "bash")).toBe(false);
    calls.find((call) => call.actor === "10001")!.finish();
    await vi.waitFor(() => expect(calls).toHaveLength(6));
    expect(JSON.stringify(calls[5]!.body.messages)).toContain("Trigger message from <10005>");
    expect(calls[5]!.body.tools?.some((tool) => tool.function.name === "bash")).toBe(false);
    for (const call of calls) call.finish();
    const results = await Promise.all(work);
    expect(results.map((result) => (result as { response: string }).response)).toEqual(
      Array.from({ length: 6 }, (_, index) => `answer-1000${index}`),
    );
    expect(peak).toBe(4);
    expect(
      owners.every(
        (owner) => owner.conversationId.startsWith("room-") && !owner.conversationId.startsWith("handoff-"),
      ),
    ).toBe(true);
    expect(new Set(owners.map((owner) => owner.discord?.actorId))).toEqual(
      new Set(Array.from({ length: 6 }, (_, i) => `1000${i}`)),
    );
    const settled = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (settled.op !== "fleet") throw new Error("Expected fleet");
    expect(settled.snapshot.cursor).not.toBe(fleet.snapshot.cursor);
    const children = settled.snapshot.roomHandoffs!;
    for (const child of children) {
      expect(child.roomHandoff).toMatchObject({ state: "completed", host: "pi" });
      const paths = await readdir(join(root, "conversations", child.conversationId, "pi"));
      expect(paths.filter((path) => path.endsWith(".jsonl"))).toHaveLength(1);
      const replay = await captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "replay",
        replay: {
          schemaVersion: 1,
          conversationId: child.conversationId,
          surfaceClientId: "fixture",
          limit: 100,
        },
      });
      OperatorConversationServiceResultSchema.parse(replay);
      expect(JSON.stringify(replay)).toContain(child.roomHandoff!.result!);
      expect(
        await readFile(join(root, "conversations", child.conversationId, "meta.json"), "utf8"),
      ).toContain(child.roomHandoff!.actorId);
    }
    // Hosted owner authority is a host-only live proof, not a saved local machine grant.
    routeCurrent = false;
    await settings.update((current) => ({
      ...current,
      discord: { ...current.discord, systemActorUserIds: [] },
    }));
    let sourceCurrent = true;
    const ownerWork = captain.submitDiscordTurn(request(6), {
      verifiedOwner: true,
      sourceCurrent: () => sourceCurrent,
    });
    work.push(ownerWork);
    await vi.waitFor(() => expect(calls).toHaveLength(7));
    expect(calls[6]!.body.tools?.some((tool) => tool.function.name === "bash")).toBe(true);
    calls[6]!.finish();
    expect(await ownerWork).toMatchObject({ state: "settled", response: "answer-10006" });
    sourceCurrent = false;
    expect(
      await captain.submitDiscordTurn(request(7), {
        verifiedOwner: true,
        sourceCurrent: () => sourceCurrent,
      }),
    ).toMatchObject({ state: "failed" });
    expect(calls).toHaveLength(7);
    const withHosted = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (withHosted.op !== "fleet") throw new Error("Expected fleet");
    const allChildren = withHosted.snapshot.roomHandoffs!;
    await captain.close();
    captain = createCaptain(deps, options);
    const restored = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (restored.op !== "fleet") throw new Error("Expected fleet");
    expect(restored.snapshot.roomHandoffs?.map((child) => child.conversationId).sort()).toEqual(
      allChildren.map((child) => child.conversationId).sort(),
    );
    expect(
      restored.snapshot.roomHandoffs?.filter((child) => child.roomHandoff?.state === "completed"),
    ).toHaveLength(7);
    expect(await captain.submitDiscordTurn(request(0))).toMatchObject({
      state: "failed",
      code: "room_handoff_already_recorded",
    });
    expect(calls).toHaveLength(7);
  } finally {
    draining = true;
    for (const call of calls) if (!call.response.writableEnded) call.finish();
    await Promise.allSettled(work);
    await captain.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
