import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SettingsStore } from "@clankie/settings";
import { DiscordTextIngress } from "@clankie/discord-presence-core";
import { expect, it, vi } from "vitest";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createDiscordTurns } from "../src/captain/captain-discord-turns.ts";
import { discordRoomDisplayTitle } from "../src/discord-room-routes.ts";

// Select the loopback provider; Pi, the text ingress, sessions and journals remain real.
const selection = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../src/captain/model.ts", () => ({ createCaptainModelRuntime: async () => selection.value }));

it("room jobs carry the Discord member's display name, and DM rooms read as DM with them (#367)", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-room-actor-name-"));
  const server = createServer(async (incoming, response) => {
    for await (const _ of incoming);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "local",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish === null ? {} : { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      })}\n\n`;
    response.end(chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
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
  const deps = {
    herdrAvailable: () => true,
    embodiment: {},
    conversationRouteAuthorized: () => true,
    memory: {
      recallEpisodeCard: async () => "",
      searchEpisodeCard: async () => "",
      recallDiscordPerson: () => "",
    },
    mcp: { catalog: async () => [] },
    browser: { catalog: async () => ({ available: false, tools: [] }) },
  } as unknown as CaptainDeps;
  const captain = createCaptain(Object.assign(deps, { roomTurns: createDiscordTurns }), {
    repoRoot: root,
    stateDir: root,
    workingDirectory: root,
    settings: new SettingsStore(join(root, "settings.json")),
    discordEnvironment: {},
    nativeCensusRunner: async () => ({ stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" }),
    seatAdapters: [],
  } as unknown as Parameters<typeof createCaptain>[1]);
  // The bodies' real ingress, submitting straight to the captain; Discord writes are recorded.
  const ingress = new DiscordTextIngress(
    {
      getHealth: async () => ({ profileHash: "fixture" }),
      submitDiscordCaptainChannelTurn: (request) => captain.submitDiscordTurn(request),
      executeDiscordPresenceAction: async (write) => ({
        id: write.idempotencyKey,
        action: write.action,
        transportKind: "bot",
        channelId: "channelId" in write.payload ? write.payload.channelId : undefined,
        messageId: write.payload.kind === "reply" ? `reply-${write.idempotencyKey}` : undefined,
      }),
    },
    {
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      guildIds: new Set(["12345"]),
      channelIds: new Set(["67890"]),
      dmPolicy: "allowlist",
      dmUserIds: new Set(["30003"]),
      contextMessageLimit: 0,
      authenticatedSurfaceUrl: "http://127.0.0.1:4311/approvals",
    },
  );
  const handoff = async (deliveryId: string) => {
    const fleet = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (fleet.op !== "fleet") throw new Error("Expected fleet");
    return fleet.snapshot.roomHandoffs?.find((child) => child.roomHandoff?.deliveryId === deliveryId);
  };
  const guild = (id: string, authorId: string, authorName: string) => ({
    id,
    guildId: "12345",
    channelId: "67890",
    authorId,
    authorName,
    authorIsBot: false,
    mentionsBot: true,
    body: `hey clankie from ${authorName}`,
    room: { guildName: "Friends", channelName: "general" },
  });
  try {
    // What each body passes: the server nickname when there is one, else the username.
    expect(await ingress.handle(guild("1400000000000000001", "20001", "Nicky"))).toMatchObject({
      state: "settled",
    });
    expect(await ingress.handle(guild("1400000000000000002", "20002", "plainuser"))).toMatchObject({
      state: "settled",
    });
    for (const [deliveryId, actorId, actorName] of [
      ["1400000000000000001", "20001", "Nicky"],
      ["1400000000000000002", "20002", "plainuser"],
    ] as const) {
      const job = await handoff(deliveryId);
      expect(job?.roomHandoff).toMatchObject({ actorId, actorName });
      expect(job?.title).toBe(`${actorName} · hey clankie from ${actorName}`);
    }

    expect(
      await ingress.handle({
        id: "1400000000000000003",
        channelId: "55555",
        authorId: "30003",
        authorName: "Pat",
        authorIsBot: false,
        mentionsBot: false,
        body: "a dm",
        room: { peerName: "Pat" },
      }),
    ).toMatchObject({ state: "settled" });
    const list = await captain.serveOperatorConversation({ schemaVersion: 1, op: "list" });
    if (list.op !== "list") throw new Error("Expected list");
    // The DM room itself (its scope is the DM channel), not the room job under it.
    const dm = list.conversations.find(
      (conversation) =>
        conversation.scope?.kind === "room" &&
        conversation.scope.targetId === "dm:55555" &&
        conversation.title.startsWith("Discord DM"),
    );
    expect(dm?.title).toBe("Discord DM · Pat");
    expect(discordRoomDisplayTitle(dm!.title)).toBe("DM with Pat");
  } finally {
    await captain.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
