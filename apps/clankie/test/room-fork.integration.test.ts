import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SettingsStore } from "@clankie/settings";
import type { DiscordCaptainActionInput, DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createCaptain } from "../src/captain/captain.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { DeliveredFileStore } from "../src/delivered-files.ts";

// Real captain, Pi sessions, room admission, conversation journals, delivered-file
// host and fork receipts against a loopback model. Only the Discord body's
// HTTP effect is replaced, at the `discordActions` transport boundary.
const selection = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../src/captain/model.ts", () => ({ createCaptainModelRuntime: async () => selection.value }));

const GUILD = "1052402897645752351";
const CHANNEL = "1551975693582336060";
const OWNER = "830574404453793842";
const ASKED = "1557079355589664801";
const ROOM = `room-${createHash("sha256").update(`discord_presence:${GUILD}:${CHANNEL}`).digest("hex").slice(0, 24)}`;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function chunk(content: string): string {
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
  const root = await mkdtemp(join(tmpdir(), "clankie-room-fork-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const prompts: string[] = [];
  const server = createServer(async (incoming, response) => {
    const parts: Buffer[] = [];
    for await (const part of incoming) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts).toString("utf8");
    prompts.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      chunk(
        body.includes("[Owner brief]") ? "The Leominster lot is 0.40 acre, the biggest yard." : "Looking.",
      ),
    );
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
  runtime.registerProvider("fork-fixture", {
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
      selection: { model: runtime.getModel("fork-fixture", "local")!, thinkingLevel: "off" },
    }),
  };
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({ ...current, discord: { ...current.discord, ownerUserId: OWNER } }));
  const posts: DiscordCaptainActionInput[] = [];
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
    discordActions: {
      execute: async (input: DiscordCaptainActionInput, guard?: () => Promise<void>) => {
        await guard?.();
        // Typing and progress cards are cosmetic; only posts are the room's words.
        if (input.action !== "send_reply" && input.action !== "post_message")
          return { ok: true, message: "Ok." };
        posts.push(input);
        return { ok: true, message: "Posted.", messageId: `posted-${String(posts.length)}` };
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
  cleanups.push(() => captain.close());
  return { root, workspace, attachments, captain, prompts, posts };
}

function roomMessage(): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: ASKED,
    identity: {
      presenceSessionId: `discord:${GUILD}:${CHANNEL}`,
      correlationId: `discord-message:${ASKED}`,
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      profileHash: "fixture",
    },
    trigger: {
      kind: "mention",
      id: ASKED,
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: ASKED,
      actorId: "692124766018076782",
      body: "Which house has the biggest yard?",
      attachments: [],
    },
    contextMessages: [],
  };
}

it("forks the owner's seat into a room: room context plus brief in, one bounded result out, both logs record it", async () => {
  const { root, workspace, attachments, captain, prompts, posts } = await fixture();
  // The room exists because someone asked in it.
  expect(await captain.submitDiscordTurn(roomMessage())).toMatchObject({ state: "settled" });
  // The owner's seat has private context the room must never see.
  expect(
    captain.syncSeatTranscript("global-default", {
      sessionId: "owner-seat",
      entries: [{ type: "message", id: "secret", role: "agent", text: "SEAT-PRIVATE-7731 budget notes" }],
      activity: "waiting",
    }),
  ).toBe(true);
  await writeFile(join(workspace, "shortlist.md"), "# Shortlist\n");

  const bank = await captain.laneToolBank("operator", "global-default");
  const tool = bank.tools.find((item) => item.name === "room_turn");
  expect(tool).toBeDefined();
  const args = {
    room: ROOM,
    brief: "Answer which listing has the biggest yard: Leominster, 0.40 acre. Attach the shortlist.",
    replyTo: ASKED,
    file: { path: "shortlist.md" },
  };
  const before = prompts.length;
  const first = await tool!.call(args);
  expect(first.isError).toBeUndefined();
  const result = JSON.parse((first.content[0] as { text: string }).text);
  expect(result).toMatchObject({
    state: "posted",
    room: ROOM,
    channelId: CHANNEL,
    replyTo: ASKED,
    messageId: "posted-1",
    file: "shortlist.md",
    text: "The Leominster lot is 0.40 acre, the biggest yard.",
  });

  // Context: the room's own log and the brief, never the seat's transcript.
  const forkPrompt = prompts.slice(before).find((body) => body.includes("[Owner brief]"))!;
  expect(forkPrompt).toContain("Which house has the biggest yard?");
  expect(forkPrompt).toContain("Leominster, 0.40 acre");
  expect(forkPrompt).not.toContain("SEAT-PRIVATE-7731");

  // Posted through the room's mouth, as a reply carrying the delivered file.
  expect(posts).toHaveLength(1);
  const post = posts[0]!;
  if (post.action !== "send_reply") throw new Error(`Expected a reply, got ${post.action}`);
  expect(post).toMatchObject({ guildId: GUILD, channelId: CHANNEL, messageId: ASKED, actorId: OWNER });
  const [, digest, relative] = /^sha256:([0-9a-f]{64}):(.+)$/u.exec(post.media!.artifactRef)!;
  expect(
    createHash("sha256")
      .update(await readFile(join(attachments, relative!)))
      .digest("hex"),
  ).toBe(digest);

  // Both logs carry it: the room turn in the room, the bounded result in the seat's conversation.
  const journal = new ConversationJournal(join(root, "conversations"));
  expect(journal.read(ROOM)).toContainEqual(
    expect.objectContaining({ type: "message", role: "captain", text: result.text }),
  );
  expect(journal.read("global-default")).toContainEqual(
    expect.objectContaining({ type: "tool", name: "room_turn", phase: "completed" }),
  );

  // A retry returns the settled result: no second model turn, no second post.
  const calls = prompts.length;
  const retry = await tool!.call(args);
  expect(JSON.parse((retry.content[0] as { text: string }).text)).toEqual(result);
  expect(prompts.length).toBe(calls);
  expect(posts).toHaveLength(1);
});

it("never offers the room fork outside the owner's operator lane", async () => {
  const { captain } = await fixture();
  expect(await captain.submitDiscordTurn(roomMessage())).toMatchObject({ state: "settled" });
  for (const lane of ["discord_presence", "discord_voice"] as const)
    expect((await captain.laneToolBank(lane)).tools.map((tool) => tool.name)).not.toContain("room_turn");
  const tool = (await captain.laneToolBank("operator", "global-default")).tools.find(
    (item) => item.name === "room_turn",
  )!;
  // A file needs a message to answer; a DM or unknown room is refused before any turn runs.
  for (const args of [
    { room: ROOM, brief: "Post the file.", file: { path: "shortlist.md" } },
    { room: "room-000000000000000000000000", brief: "Hello." },
  ]) {
    const refused = await tool.call(args);
    expect(refused.isError).toBe(true);
  }
});
