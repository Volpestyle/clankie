import { CaptainEpisodeSchema } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createCaptainMemory } from "../src/captain-memory.ts";
import { createFileMemory } from "../src/memory.ts";

it("migrates legacy notes and exercises memory through the real MCP endpoint with console privacy intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-memory-mcp-"));
  const dataDir = join(root, "memory");
  const episodesDir = join(dataDir, "captain-episodes");
  await mkdir(episodesDir, { recursive: true });
  // Synthetic v1 records exercise the existing on-disk format without opening
  // the owner's store. Include legacy defaults and private/shared provenance.
  const legacy = Array.from({ length: 35 }, (_, index) => ({
    schemaVersion: 1 as const,
    episodeId: `legacy-${index}`,
    lane: index % 2 === 0 ? ("operator" as const) : ("discord_presence" as const),
    targetId: index % 2 === 0 ? "global-default" : "guild:channel",
    ...(index === 0 ? {} : { sourceConversationId: index % 2 === 0 ? "global-default" : "discord-room" }),
    summary: `${index % 2 === 0 ? "private" : "shared"} legacy note ${index}`,
    visibility: index % 2 === 0 ? ("operator_private" as const) : ("shareable" as const),
    ...(index === 0 ? {} : { retained: index % 3 === 0 }),
    provenance: {
      characterId: "clankie",
      sessionId: "legacy-session",
      selfAuthored: true as const,
      rawTranscript: false as const,
    },
    occurredAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
  }));
  const files = new Map<string, string>();
  for (const lane of ["operator", "discord_presence"] as const) {
    const path = join(episodesDir, `${lane}.jsonl`);
    const bytes =
      legacy
        .filter((note) => note.lane === lane)
        .map((note) => JSON.stringify(note))
        .join("\n") + "\n";
    files.set(path, bytes);
    await writeFile(path, bytes);
  }
  const memory = createFileMemory({ dataDir });
  expect(memory.catalog().captainEpisodes).toHaveLength(35);
  for (const [path, bytes] of files) expect(await readFile(path, "utf8")).toBe(bytes);
  const normalizedLegacy = legacy.map((note) => CaptainEpisodeSchema.parse(note));
  for (const note of normalizedLegacy) expect(memory.catalog().captainEpisodes).toContainEqual(note);

  const memoryDeps = createCaptainMemory(memory);
  // A Discord host's write uses the production adapter, and its subsequent
  // search travels through the authenticated MCP surface below.
  const shared = await memoryDeps.writeMemory({
    lane: "discord_presence",
    sourceConversationId: "discord-room",
    targetId: "guild:channel",
    text: "Discord shared-memory probe",
  });
  expect(memory.catalog().captainEpisodes.find((note) => note.episodeId === shared.id)?.visibility).toBe(
    "shareable",
  );
  // Inactive integrations have empty catalogs. Every exercised boundary uses
  // the real captain, file store, production adapter, HTTP server and MCP SDK.
  const captain = createCaptain(
    {
      memory: memoryDeps,
      herdrAvailable: () => false,
      browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }) },
      mcp: { catalog: async () => [] },
      embodiment: {},
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: join(root, "captain"),
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  const app = await createClankieApp({
    captain,
    memory,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer console" ? { operatorId: "fixture-owner" } : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer discord"
        ? { captainId: "fixture-body", steerSourceLane: "discord_text" }
        : undefined,
  });
  const server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No loopback address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1/mcp`;
  const clients: Client[] = [];
  async function connect(bearer: string, conversationId?: string): Promise<Client> {
    const client = new Client({ name: "memory-integration", version: "1" });
    clients.push(client);
    const url = new URL(baseUrl);
    if (conversationId !== undefined) url.searchParams.set("conversationId", conversationId);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      }) as unknown as Transport,
    );
    return client;
  }
  async function invoke(client: Client, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name: "memory", arguments: args });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }
  try {
    const consoleClient = await connect("console");
    const discordClient = await connect("discord");
    for (const client of [consoleClient, discordClient]) {
      const tools = (await client.listTools()).tools;
      expect(tools.filter((tool) => tool.name === "memory")).toHaveLength(1);
      expect(tools.map((tool) => tool.name)).not.toContain("remember_episode");
      expect(tools.map((tool) => tool.name)).not.toContain("recall_episodes");
    }
    const written = await invoke(consoleClient, { action: "write", text: "console-only privacy-probe" });
    expect(written).toMatchObject({ action: "write", written: true, text: "console-only privacy-probe" });
    expect(typeof written.id).toBe("string");
    const id = written.id as string;
    const original = memory.catalog().captainEpisodes.find((note) => note.episodeId === id)!;
    expect(original).toMatchObject({
      lane: "operator",
      visibility: "operator_private",
      sourceConversationId: "global-default",
    });
    expect((await invoke(consoleClient, { action: "search", query: "privacy-probe" })).card).toContain(id);
    expect(await invoke(discordClient, { action: "search", query: "privacy-probe" })).toEqual({
      action: "search",
      found: 0,
      card: "",
    });
    expect((await invoke(discordClient, { action: "search", query: "shared-memory" })).card).toContain(
      shared.id,
    );
    expect((await invoke(discordClient, { action: "search", query: "shared legacy" })).card).toContain(
      "legacy-",
    );
    expect(await invoke(discordClient, { action: "search", query: "private legacy" })).toEqual({
      action: "search",
      found: 0,
      card: "",
    });
    expect(await captain.laneMemoryCard("discord_presence")).not.toContain("privacy-probe");
    expect(await captain.laneMemoryCard("discord_presence")).not.toContain("private legacy");
    expect(await captain.laneMemoryCard("operator")).toContain("privacy-probe");

    const wrongRoom = await captain.serveOperatorConversation({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "workspace", workspaceId: root },
      title: "Other console room",
    });
    if (wrongRoom.op !== "create") throw new Error("Conversation creation failed");
    const otherClient = await connect("console", wrongRoom.conversation.conversationId);
    for (const action of ["edit", "forget"] as const) {
      const receipt = await invoke(otherClient, {
        action,
        id,
        ...(action === "edit" ? { text: "forged replacement" } : {}),
      });
      expect(receipt.reason).toBe("not_found");
    }
    expect(memory.catalog().captainEpisodes.find((note) => note.episodeId === id)).toEqual(original);
    const count = memory.catalog().captainEpisodes.length;
    expect(
      await invoke(consoleClient, { action: "edit", id: "missing", text: "no fallback append" }),
    ).toMatchObject({ edited: false, reason: "not_found" });
    expect(memory.catalog().captainEpisodes).toHaveLength(count);
    expect(
      await invoke(consoleClient, { action: "edit", id, text: "console-only corrected-probe" }),
    ).toMatchObject({ edited: true, id });
    const edited = memory.catalog().captainEpisodes.find((note) => note.episodeId === id)!;
    expect(edited).toMatchObject({ ...original, summary: "console-only corrected-probe" });
    expect(edited.correctedAt).toBeDefined();
    expect(memory.catalog().captainEpisodes).toHaveLength(count);
    expect(await invoke(discordClient, { action: "search", query: "corrected-probe" })).toMatchObject({
      found: 0,
    });

    for (const args of [
      { action: "write", text: "forged visibility", visibility: "shareable" },
      { action: "write", text: "forged room", lane: "discord_presence" },
      { action: "write", text: "retained shelf", retain: true },
      { action: "edit", id, text: "forged source", sourceConversationId: "global-default" },
      { action: "write", text: "x".repeat(513) },
    ]) {
      const invalid = await consoleClient.callTool({ name: "memory", arguments: args });
      expect(invalid.isError).toBe(true);
    }
    expect(memory.catalog().captainEpisodes).toHaveLength(count);
    const restarted = createFileMemory({ dataDir });
    expect(restarted.catalog().captainEpisodes.find((note) => note.episodeId === id)).toEqual(edited);
    for (const note of normalizedLegacy) expect(restarted.catalog().captainEpisodes).toContainEqual(note);
    expect(await invoke(consoleClient, { action: "forget", id })).toEqual({
      action: "forget",
      forgotten: true,
    });
    expect(await invoke(consoleClient, { action: "search", query: "corrected-probe" })).toMatchObject({
      found: 0,
    });
    expect(await invoke(consoleClient, { action: "forget", id })).toEqual({
      action: "forget",
      forgotten: false,
      reason: "not_found",
    });
    expect(createFileMemory({ dataDir }).catalog().captainEpisodes).toHaveLength(36);
    expect(memory.catalog().discordPeople).toEqual([]);
  } finally {
    for (const client of clients) await client.close();
    app.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await captain.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
