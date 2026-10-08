import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DiscordPresenceSession,
  admitCaptainDiscordAction,
  executePlannedCaptainDiscordAction,
} from "@clankie/discord-presence-core";
import { SettingsStore } from "@clankie/settings";
import type {
  DiscordCaptainActionInput,
  DiscordCaptainActionResult,
  DiscordPresenceWrite,
} from "@clankie/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { BodyLeaseRouter } from "../src/body-lease-router.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { DiscordTurnReceipts } from "../src/captain/discord-turn-receipts.ts";
import { DeliveredFileStore } from "../src/delivered-files.ts";

// The live failure (room_fork_room_authority_unavailable) came from the app's
// real route authority, which the first fork test never wired. Here the real
// captain runs inside the real app: its route check is the app's
// conversationBodyRouteAuthorized, its Discord actions go through the shared
// body admission and the service's presence-action route with body leases on.
// Only the Discord REST effect and the model are replaced.
const selection = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../src/captain/model.ts", () => ({ createCaptainModelRuntime: async () => selection.value }));

const GUILD = "1052402897645752351";
const CHANNEL = "1551975693582336060";
const OWNER = "830574404453793842";
const MEMBER = "692124766018076782";
const ASKED = "1557079355589664801";
const ROOM = `room-${createHash("sha256").update(`discord_presence:${GUILD}:${CHANNEL}`).digest("hex").slice(0, 24)}`;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function stream(content: string): string {
  const frame = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "local",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish === null ? {} : { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    })}\n\n`;
  return `${frame({ role: "assistant", content }, null)}${frame({}, "stop")}data: [DONE]\n\n`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-room-fork-authority-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const prompts: { body: string; tools: string[] }[] = [];
  const server = createServer(async (incoming, response) => {
    const parts: Buffer[] = [];
    for await (const part of incoming) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts).toString("utf8");
    const parsed = JSON.parse(body) as { tools?: { function: { name: string } }[] };
    prompts.push({ body, tools: (parsed.tools ?? []).map((tool) => tool.function.name) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(stream(body.includes("[Owner brief]") ? "Leominster has the biggest yard." : "Looking."));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback address");
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("authority-fixture", {
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
      selection: { model: runtime.getModel("authority-fixture", "local")!, thinkingLevel: "off" },
    }),
  };
  // The owner holds machine access personally; this room grants none.
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: {
      ...current.discord,
      servers: [{ serverId: GUILD, role: "participant", owners: "me" }],
      ownerUserId: OWNER,
      systemActorUserIds: [OWNER],
    },
  }));

  let app: ClankieApp | undefined;
  let session: DiscordPresenceSession | undefined;
  const effects: DiscordPresenceWrite[] = [];
  const bridgePost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app!.app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer bridge", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  // The official bot body's captain-action handler, minus its Discord client.
  const bodyExecute = async (input: DiscordCaptainActionInput): Promise<DiscordCaptainActionResult> => {
    const admitted = admitCaptainDiscordAction({
      action: input,
      admittedGuildIds: new Set([GUILD]),
      admittedChannelIds: new Set(),
      ownsProgressMessage: () => false,
    });
    if (admitted.kind !== "plan")
      return admitted.kind === "refuse" ? admitted.result : { ok: false, message: "watch" };
    try {
      return await executePlannedCaptainDiscordAction({
        call: input,
        plan: admitted.plan,
        guildId: admitted.guildId,
        channelId: admitted.channelId,
        characterId: "clankie",
        credentialRef: "discord_bot",
        transportKind: "bot",
        presencePort: {
          getHealth: async () => ({ profileHash: "unversioned" }),
          executeDiscordPresenceAction: async (write) => {
            const response = await bridgePost("/v1/discord/presence-actions", write, {
              "x-clankie-discord-presence-session": session!.record.sessionId,
              "x-clankie-discord-presence-phase": session!.record.phase,
              "x-clankie-discord-presence-revision": String(session!.record.revision),
            });
            if (!response.ok) throw new Error(`presence ${response.status}: ${await response.text()}`);
            return (await response.json()) as { messageId?: string };
          },
        },
        progressMessageIds: new Set(),
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const deps = {
    herdrAvailable: () => false,
    embodiment: {},
    memory: {
      recallEpisodeCard: async () => "",
      searchEpisodeCard: async () => "",
      recallDiscordPerson: () => "",
    },
    mcp: { catalog: async () => [] },
    browser: { catalog: async () => ({ available: false, tools: [] }) },
    // Production wiring (index.ts): the app's own route authority.
    conversationRouteAuthorized: (
      owner: Parameters<NonNullable<CaptainDeps["conversationRouteAuthorized"]>>[0],
    ) => app?.conversationBodyRouteAuthorized(owner) ?? false,
    discordActions: {
      serverAction: async (action: { path: string }) => ({
        ok: true,
        message: "Owner-only room metadata",
        data:
          action.path === "/users/@me"
            ? { id: "30001", bot: true }
            : action.path === `/guilds/${GUILD}`
              ? { id: GUILD, owner_id: OWNER }
              : action.path === `/guilds/${GUILD}/roles`
                ? [{ id: GUILD, permissions: "0" }]
                : {
                    id: CHANNEL,
                    guild_id: GUILD,
                    permission_overwrites: [
                      { id: GUILD, type: 0, allow: "0", deny: "1024" },
                      { id: "30001", type: 1, allow: "1024", deny: "0" },
                    ],
                  },
      }),
      execute: async (input: DiscordCaptainActionInput, guard?: () => Promise<void>) => {
        await guard?.();
        return bodyExecute(input);
      },
    },
  } as unknown as CaptainDeps;
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const attachments = join(root, "attachments");
  const captain = createCaptain(deps, {
    repoRoot: root,
    stateDir: root,
    workingDirectory: workspace,
    settings,
    discordEnvironment: {},
    deliveredFiles: new DeliveredFileStore(attachments),
    personaImages: async () => ({ images: [], hash: "fixture", files: [] }),
  });
  const store = new BodyLeaseStore(root);
  app = await createClankieApp({
    captain,
    discordTurnReceipts: new DiscordTurnReceipts(join(root, "receipts.json")),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer bridge"
        ? { captainId: "body", steerSourceLane: "discord_text" }
        : undefined,
    bodyLeases: { store, router: new BodyLeaseRouter(store), confirmStopped: async () => false },
    discordPresenceRuntime: {
      execute: async (write, _session, guard) => {
        await guard?.();
        effects.push(write);
        return {
          id: write.idempotencyKey,
          action: write.action,
          transportKind: "bot",
          channelId: CHANNEL,
          messageId: `discord-${String(effects.length)}`,
        };
      },
    },
  });
  cleanups.push(async () => {
    await app!.close();
    store.close();
    await captain.close();
  });
  session = new DiscordPresenceSession({
    sessionId: "bot-session",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot",
    emit: async (event) => {
      const response = await bridgePost("/v1/discord/presence-session-events", event);
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).session;
    },
  });
  await session.start();
  await session.gatewayReady();
  // Another household member asks in the room; that delivery holds the only receipt.
  const asked = await bridgePost("/v1/captain/channel-turns", {
    schemaVersion: 1,
    deliveryId: ASKED,
    identity: {
      presenceSessionId: `discord:${GUILD}:${CHANNEL}`,
      correlationId: `discord-message:${ASKED}`,
      profileHash: "unversioned",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
    },
    trigger: {
      kind: "mention",
      id: ASKED,
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: ASKED,
      actorId: MEMBER,
      body: "Which house has the biggest yard?",
      attachments: [],
    },
    contextMessages: [],
  });
  expect(asked.status).toBe(200);
  const tool = (await captain.laneToolBank("operator", "global-default")).tools.find(
    (item) => item.name === "room_turn",
  )!;
  return { tool, effects, prompts, workspace, session };
}

const parse = (result: { content: readonly { type: string; text?: string }[] }) =>
  JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

it("posts an owner-directed reply to another member's message, with its file, under the room's grants", async () => {
  const { tool, effects, prompts, workspace } = await fixture();
  await writeFile(join(workspace, "realtor-brief.md"), "# What we want\n");
  const before = effects.length;
  const promptsBefore = prompts.length;
  const result = parse(
    await tool.call({
      room: ROOM,
      brief: "Answer the yard question: Leominster, 0.40 acre. Attach the realtor brief.",
      replyTo: ASKED,
      file: { path: "realtor-brief.md" },
      requestId: "house-hunting-realtor-brief-20261006",
    }),
  );
  expect(result).toMatchObject({ state: "posted", replyTo: ASKED, file: "realtor-brief.md" });
  const posted = effects.slice(before);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    action: "discord.presence.reply_with_media",
    payload: { kind: "reply_with_media", channelId: CHANNEL, messageId: ASKED, filename: "realtor-brief.md" },
  });
  expect(result.messageId).toBe(`discord-${String(effects.length)}`);
  // The fork is owner-authored and the host proved every reader is an owner.
  const fork = prompts.slice(promptsBefore).find((prompt) => prompt.body.includes("[Owner brief]"))!;
  expect(fork.tools).toContain("bash");
});

it("posts an owner-directed message that answers nobody, and refuses once the room's body is gone", async () => {
  const { tool, effects, session } = await fixture();
  const before = effects.length;
  const result = parse(
    await tool.call({ room: ROOM, brief: "Tell the room the open house is Saturday at 1." }),
  );
  expect(result).toMatchObject({ state: "posted", room: ROOM });
  const posted = effects.slice(before);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    action: "discord.presence.send_message",
    payload: { channelId: CHANNEL },
  });
  expect(posted[0]!.payload).not.toHaveProperty("replyToMessageId");

  // No live Discord body: a definite refusal before dispatch, not stored, so it can retry.
  await session.gatewayDisconnected();
  const refused = await tool.call({ room: ROOM, brief: "Second note.", requestId: "retry-after-reconnect" });
  expect(refused.isError).toBe(true);
  expect(parse(refused)).toMatchObject({ state: "failed", code: "room_fork_room_authority_unavailable" });
});
