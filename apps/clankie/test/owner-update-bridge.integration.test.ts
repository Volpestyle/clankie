import { serve } from "@hono/node-server";
import { SettingsStore } from "@clankie/settings";
import {
  OWNER_UPDATE_PUBLICATION_META,
  OwnerUpdateSchema,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";

it("keeps distinct mail calls unique through real stdio bridge and service restarts, preserving exact retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-mail-bridge-"));
  // The mailbox needs no model, browser or connected account. Production captain,
  // lane registry, MCP transports and persistence handle every publication.
  const deps = {
    herdrAvailable: () => false,
    browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }) },
    mcp: { catalog: async () => [] },
    embodiment: {
      submitIntent: async () => {
        throw new Error("Mailbox must not use an embodiment");
      },
      getSession: async () => {
        throw new Error("Mailbox must not use an embodiment");
      },
      getLiveSession: async () => {
        throw new Error("Mailbox must not use an embodiment");
      },
    },
    memory: { recallMemoryCard: async () => "", searchMemory: async () => "" },
  } as unknown as CaptainDeps;
  const openService = async () => {
    const captain = createCaptain(deps, {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
    });
    const app = await createClankieApp({
      captain,
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer mail-fixture"
          ? { operatorId: "mail-owner" }
          : undefined,
    });
    return { captain, app };
  };
  let service = await openService();
  const attempts: { title: string; publicationId?: string; status: number }[] = [];
  let loseNextResult = false;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body =
        request.method === "POST"
          ? await request
              .clone()
              .json()
              .catch(() => undefined)
          : undefined;
      let response = await service.app.app.fetch(request);
      if (loseNextResult && response.status === 200 && body?.params?.name === "mail_owner_update") {
        loseNextResult = false;
        response = new Response("Publication reply lost", { status: 502 });
      }
      if (body?.method === "tools/call" && body.params?.name === "mail_owner_update")
        attempts.push({
          title: body.params.arguments.title,
          publicationId: body.params._meta?.[OWNER_UPDATE_PUBLICATION_META]?.publicationId,
          status: response.status,
        });
      return response;
    },
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback listener");
  const host = `http://127.0.0.1:${address.port}`;
  const bridges: { client: Client; transport: StdioClientTransport }[] = [];
  let legacy: Client | undefined;
  const openBridge = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        join(import.meta.dirname, "fixtures/mcp-stdio-bridge.ts"),
        host,
        "mail-fixture",
      ],
      cwd: join(import.meta.dirname, ".."),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: "native-mail-seat", version: "1" });
    bridges.push({ client, transport });
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`Failed to start stdio bridge: ${stderr}`, { cause: error });
    }
    return client;
  };
  const draft = { title: "First deliberate update", body: "Landed work worth the owner's attention." };
  const mail = async (client: Client, args = draft, meta?: CallToolResult["_meta"]) =>
    client.callTool({ name: "mail_owner_update", arguments: args, ...(meta ? { _meta: meta } : {}) });
  const update = (result: Awaited<ReturnType<typeof mail>>) => {
    expect(result.isError).not.toBe(true);
    const content = result.content as { type: string; text: string }[];
    return OwnerUpdateSchema.parse(JSON.parse(content.find((item) => item.type === "text")!.text));
  };
  const list = async () => {
    const response = await fetch(`${host}/operator/v1/dispatch`, {
      method: "POST",
      headers: { authorization: "Bearer mail-fixture", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, op: "owner_update_list", state: "all" }),
    });
    expect(response.status).toBe(200);
    const result = OperatorConversationServiceResultSchema.parse(await response.json());
    if (result.op !== "owner_update_list") throw new Error("Wrong mailbox result");
    return result.result.updates;
  };
  try {
    const firstBridge = await openBridge();
    const firstResult = await mail(firstBridge);
    const first = update(firstResult);
    const firstIdentity = firstResult._meta?.[OWNER_UPDATE_PUBLICATION_META];
    expect(firstIdentity).toMatchObject({ publicationId: expect.any(String) });
    const second = update(await mail(firstBridge)); // Same content, distinct deliberate call.
    expect(second.id).not.toBe(first.id);
    expect(update(await mail(firstBridge, draft, firstResult._meta)).id).toBe(first.id);
    expect(
      (await mail(firstBridge, { ...draft, body: "Different content" }, firstResult._meta)).isError,
    ).toBe(true);
    const invalid = await mail(firstBridge, draft, {
      [OWNER_UPDATE_PUBLICATION_META]: { publicationId: "reset-counter-1" },
    });
    expect(invalid.isError).toBe(true);
    expect(await list()).toHaveLength(2);

    // Expire the HTTP session while leaving the attached native bridge alive.
    // Its first POST is explicitly rejected before admission; only that reply
    // permits reconnect/replay, with the same already-allocated publication ID.
    service.app.close();
    await service.captain.close();
    service = await openService();
    const afterService = update(await mail(firstBridge, { ...draft, title: "After service restart" }));
    const replay = attempts.filter((attempt) => attempt.title === "After service restart");
    expect(replay.map((attempt) => attempt.status)).toEqual([404, 200]);
    expect(replay[0]!.publicationId).toBeTruthy();
    expect(replay[1]!.publicationId).toBe(replay[0]!.publicationId);
    expect(afterService.id).not.toBe(first.id);
    const lostDraft = { ...draft, title: "Published before the reply was lost" };
    const lostIdentity = { [OWNER_UPDATE_PUBLICATION_META]: { publicationId: randomUUID() } };
    loseNextResult = true;
    await expect(mail(firstBridge, lostDraft, lostIdentity)).rejects.toThrow();
    expect(attempts.filter((attempt) => attempt.title === lostDraft.title)).toHaveLength(1);
    const lostUpdate = (await list()).find((item) => item.title === lostDraft.title)!;
    expect(lostUpdate).toBeDefined();
    await firstBridge.close();

    // New stdio process and MCP counters, same persisted source conversation.
    const restartedBridge = await openBridge();
    const restarted = update(await mail(restartedBridge, { ...draft, title: "After bridge restart" }));
    expect(restarted.id).not.toBe(first.id);
    expect(update(await mail(restartedBridge, draft, firstResult._meta)).id).toBe(first.id);
    expect(update(await mail(restartedBridge, lostDraft, lostIdentity)).id).toBe(lostUpdate.id);
    const identicalNew = update(await mail(restartedBridge));
    expect(identicalNew.id).not.toBe(first.id);
    expect(identicalNew.id).not.toBe(second.id);

    // An older/direct MCP caller without publication metadata also gets a
    // fresh host identity, rather than the old constant authored-tool ID.
    legacy = new Client({ name: "legacy-mail-client", version: "1" });
    await legacy.connect(
      new StreamableHTTPClientTransport(new URL(`${host}/v1/mcp`), {
        requestInit: { headers: { authorization: "Bearer mail-fixture" } },
      }) as unknown as Transport,
    );
    const legacyFirst = update(await mail(legacy));
    expect(update(await mail(legacy)).id).not.toBe(legacyFirst.id);
    const updates = await list();
    expect(updates).toHaveLength(8);
    expect(new Set(updates.map((item) => item.id)).size).toBe(8);
    expect(updates.every((item) => item.conversationId === "global-default" && item.state === "unread")).toBe(
      true,
    );
  } finally {
    await legacy?.close();
    for (const bridge of bridges) {
      await bridge.client.close();
      await bridge.transport.close();
    }
    service.app.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await service.captain.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30_000);
