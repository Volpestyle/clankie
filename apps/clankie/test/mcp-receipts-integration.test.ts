import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain, type LaneTool } from "../src/captain/port.ts";

function gate<T = void>() {
  let release!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(unreadableReceiptPath = false) {
  const root = await mkdtemp(join(tmpdir(), "clankie-mcp-receipts-"));
  const bearer = randomUUID();
  const effectsPath = join(root, "effects.jsonl");
  if (unreadableReceiptPath) await mkdir(join(root, "seat-call-receipts.json"));
  const admitted = gate<{ tool: string; id: string }>();
  const finish = gate();
  const dropSibling = gate<() => void>();
  let dropArmed = false;
  let banks = 0;
  const secondBank = gate();
  const tools: LaneTool[] = [
    ...["message_seat", "hire_agent"].map(
      (name): LaneTool => ({
        name,
        description: "Controlled external action; durable observation before returning its receipt.",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        call: async (args) => {
          const id = randomUUID();
          await appendFile(effectsPath, `${JSON.stringify({ tool: name, id, args })}\n`);
          admitted.release({ tool: name, id });
          if (args.hold === true) await finish.promise;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  outcome: name === "message_seat" ? "delivered" : "started",
                  ...(name === "message_seat" ? { deliveryId: id } : { hireId: id }),
                  seatId: "fixture-seat",
                }),
              },
            ],
          };
        },
      }),
    ),
    {
      name: "fixture_dependency_error",
      description: "A sibling dependency fails through the real MCP endpoint.",
      inputSchema: { type: "object", properties: {} },
      call: async () => {
        throw new Error("fixture dependency failed");
      },
    },
    {
      name: "fixture_connection_drop",
      description: "A sibling dependency loses its actual TCP response while other calls remain live.",
      inputSchema: { type: "object", properties: {} },
      call: async () => {
        (await dropSibling.promise)();
        return { content: [{ type: "text", text: "This response was lost on the actual TCP connection." }] };
      },
    },
    {
      name: "linear_get_issue",
      description: "Controlled external read confirms the fresh MCP session remains usable.",
      inputSchema: { type: "object", properties: {} },
      call: async () => ({ content: [{ type: "text", text: "VUH-1638 fixture issue" }] }),
    },
  ];
  const boot = () =>
    createClankieApp({
      captain: createStubCaptain({
        laneToolBank: async (lane) => {
          banks++;
          if (banks === 2) secondBank.release();
          return { lane, tools };
        },
      }),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === `Bearer ${bearer}`
          ? { operatorId: "integration-operator" }
          : undefined,
      authenticateCaptain: async (request) =>
        request.headers.get("authorization") === `Bearer ${bearer}:discord`
          ? { captainId: "integration-captain", steerSourceLane: "discord_text" }
          : undefined,
      seatCallReceiptPath: join(root, "seat-call-receipts.json"),
    });
  let service = await boot();
  const http = serve({
    fetch: (request) => service.app.fetch(request),
    hostname: "127.0.0.1",
    port: 0,
  }) as HttpServer;
  http.on("request", (request, response) => {
    if (!dropArmed || request.method !== "POST" || request.url !== "/v1/mcp") return;
    dropArmed = false;
    dropSibling.release(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    http.once("listening", resolve);
    http.once("error", reject);
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("Fixture has no loopback port");
  const host = `http://127.0.0.1:${address.port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(import.meta.dirname, "fixtures/mcp-stdio-bridge.ts"), host, bearer],
    cwd: join(import.meta.dirname, ".."),
    env: { PATH: process.env.PATH ?? "", HOME: root },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "persistent-native-seat-surrogate", version: "1" });
  let closed = false;
  client.onclose = () => {
    closed = true;
  };
  try {
    await client.connect(transport as unknown as Transport, { timeout: 10_000 });
  } catch (error) {
    finish.release();
    await client.close().catch(() => undefined);
    service.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    throw new Error(`Failed to start real stdio bridge: ${stderr}`, { cause: error });
  }
  return {
    client,
    host,
    bearer,
    armSiblingDrop: () => {
      dropArmed = true;
    },
    admitted: admitted.promise,
    finish: () => finish.release(),
    secondBank: secondBank.promise,
    banks: () => banks,
    closed: () => closed,
    pid: () => transport.pid,
    effects: async () => {
      const bytes = await readFile(effectsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return bytes
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { tool: string; id: string });
    },
    async restart(dropConnections = true) {
      service.close();
      if (dropConnections) http.closeAllConnections();
      service = await boot();
    },
    async close() {
      finish.release();
      await client.close();
      service.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

it.each([
  { name: "message_seat", sibling: "fixture_dependency_error", reconnects: false },
  { name: "hire_agent", sibling: "fixture_dependency_error", reconnects: false },
  { name: "message_seat", sibling: "fixture_connection_drop", reconnects: true },
  { name: "hire_agent", sibling: "fixture_connection_drop", reconnects: true },
])(
  "preserves the admitted $name receipt after $sibling while the stdio seat continues",
  async ({ name, sibling, reconnects }) => {
    const f = await fixture();
    try {
      const pid = f.pid();
      expect((await f.client.listTools()).tools.map((tool) => tool.name)).toContain(name);
      const pending = f.client.callTool({ name, arguments: { hold: true } }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const admitted = await f.admitted;
      expect(admitted.tool).toBe(name);
      if (reconnects) f.armSiblingDrop();
      await expect(f.client.callTool({ name: sibling, arguments: {} })).rejects.toThrow();
      expect((await f.client.listTools()).tools.map((tool) => tool.name)).toContain("linear_get_issue");
      if (reconnects) await f.secondBank;
      const read = await f.client.callTool({ name: "linear_get_issue", arguments: {} });
      expect(read.content).toEqual([{ type: "text", text: "VUH-1638 fixture issue" }]);
      f.finish();
      const receipt = await pending;
      expect(receipt).toHaveProperty("result");
      if (!("result" in receipt)) throw receipt.error;
      expect(receipt.result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            outcome: name === "message_seat" ? "delivered" : "started",
            ...(name === "message_seat" ? { deliveryId: admitted.id } : { hireId: admitted.id }),
            seatId: "fixture-seat",
          }),
        },
      ]);
      const meta = receipt.result._meta?.["clankie/seat-call"] as Record<string, unknown>;
      expect(meta).toMatchObject({ tool: name, state: "settled", id: expect.any(String) });
      expect(meta[name === "message_seat" ? "deliveryId" : "hireId"]).toBe(meta.id);
      expect(f.closed()).toBe(false);
      expect(f.pid()).toBe(pid);
      expect(f.banks()).toBe(reconnects ? 2 : 1);
      expect(await f.effects()).toEqual([{ tool: name, id: admitted.id, args: { hold: true } }]);
    } finally {
      await f.close();
    }
  },
);

it.each([
  { name: "message_seat", dropConnections: false },
  { name: "hire_agent", dropConnections: false },
  { name: "message_seat", dropConnections: true },
  { name: "hire_agent", dropConnections: true },
])(
  "returns stable $name uncertainty and reconciles its one admitted effect after restart (TCP drop: $dropConnections)",
  async ({ name, dropConnections }) => {
    const f = await fixture();
    try {
      const pid = f.pid();
      const pending = f.client.callTool({ name, arguments: { hold: true } }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const admitted = await f.admitted;
      await f.restart(dropConnections);
      const lost = await pending;
      expect(lost).toHaveProperty("result");
      if (!("result" in lost)) throw lost.error;
      expect(lost.result.isError).toBe(true);
      const receipt = JSON.parse((lost.result.content as { text: string }[])[0]!.text) as Record<
        string,
        unknown
      >;
      const idKey = name === "message_seat" ? "deliveryId" : "hireId";
      const callId = receipt[idKey];
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        outcome: "uncertain",
        deliveryStage: "uncertain",
        tool: name,
        reconcileTool: "reconcile_seat_call",
        [idKey]: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      });
      expect(lost.result._meta?.["clankie/seat-call"]).toMatchObject({
        id: callId,
        tool: name,
        state: "uncertain",
        [idKey]: callId,
      });
      const catalog = await f.client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toContain("reconcile_seat_call");
      const readPending = await f.client.callTool({
        name: "reconcile_seat_call",
        arguments: { [idKey]: callId },
      });
      expect(readPending.isError).toBe(true);
      expect(JSON.parse((readPending.content as { text: string }[])[0]!.text)).toMatchObject({
        outcome: "uncertain",
        [idKey]: callId,
      });
      expect(await f.effects()).toEqual([{ tool: name, id: admitted.id, args: { hold: true } }]);
      f.finish();
      let reconciled = await f.client.callTool({
        name: "reconcile_seat_call",
        arguments: { [idKey]: callId },
      });
      // Read-only protocol probes synchronize with the actual old callback's durable settlement.
      for (let reads = 0; reconciled.isError === true && reads < 20; reads++)
        reconciled = await f.client.callTool({ name: "reconcile_seat_call", arguments: { [idKey]: callId } });
      expect(reconciled.isError).not.toBe(true);
      expect(reconciled.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            outcome: name === "message_seat" ? "delivered" : "started",
            ...(name === "message_seat" ? { deliveryId: admitted.id } : { hireId: admitted.id }),
            seatId: "fixture-seat",
          }),
        },
      ]);
      expect(reconciled._meta?.["clankie/seat-call"]).toMatchObject({
        id: callId,
        tool: name,
        state: "settled",
        [idKey]: callId,
      });
      expect(await f.effects()).toHaveLength(1);
      expect(f.pid()).toBe(pid);
      expect(f.closed()).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it("an older SDK client reuses the exact protected ID after restart without dispatching again or crossing conversations or lanes", async () => {
  const f = await fixture();
  const clients: Client[] = [];
  const connect = async (conversationId?: string, discord = false) => {
    const client = new Client({ name: "older-direct-sdk-seat", version: "1" });
    clients.push(client);
    const url = new URL("/v1/mcp", f.host);
    if (conversationId !== undefined) url.searchParams.set("conversationId", conversationId);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${f.bearer}${discord ? ":discord" : ""}` } },
      }) as unknown as Transport,
    );
    return client;
  };
  try {
    const id = randomUUID();
    const call = {
      name: "message_seat",
      arguments: { text: "original exact intent" },
      _meta: { "clankie/seat-call": { id } },
    };
    const firstClient = await connect();
    const original = await firstClient.callTool(call);
    expect(original.isError).not.toBe(true);
    await f.restart(false);
    const restarted = await connect();
    const repeated = await restarted.callTool(call);
    expect(repeated.content).toEqual(original.content);
    expect(repeated._meta?.["clankie/seat-call"]).toMatchObject({
      id,
      tool: "message_seat",
      state: "settled",
      deliveryId: id,
    });
    const collision = await restarted.callTool({ ...call, arguments: { text: "different intent" } });
    expect(collision.isError).toBe(true);
    const foreign = await connect("another-conversation");
    const refused = await foreign.callTool({ name: "reconcile_seat_call", arguments: { deliveryId: id } });
    expect(refused.isError).toBe(true);
    expect(refused.content).not.toEqual(original.content);
    const foreignRepeat = await foreign.callTool(call);
    expect(foreignRepeat.isError).toBe(true);
    expect(foreignRepeat.content).not.toEqual(original.content);
    const social = await connect(undefined, true);
    expect((await social.listTools()).tools.map((tool) => tool.name)).not.toContain("reconcile_seat_call");
    const wrongLane = await social.callTool({ name: "reconcile_seat_call", arguments: { deliveryId: id } });
    expect(wrongLane.isError).toBe(true);
    expect(wrongLane.content).not.toEqual(original.content);
    expect(await f.effects()).toHaveLength(1);
    const legacy = await restarted.callTool({
      name: "message_seat",
      arguments: { text: "legacy client omits metadata" },
    });
    expect(legacy.isError).not.toBe(true);
    const legacyMeta = legacy._meta?.["clankie/seat-call"] as Record<string, unknown>;
    expect(legacyMeta).toMatchObject({ tool: "message_seat", state: "settled", id: expect.any(String) });
    expect(legacyMeta.deliveryId).toBe(legacyMeta.id);
    const effects = await f.effects();
    expect(effects).toHaveLength(2);
    expect(legacy.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ outcome: "delivered", deliveryId: effects[1]!.id, seatId: "fixture-seat" }),
      },
    ]);
    expect(f.closed()).toBe(false);
  } finally {
    for (const client of clients) await client.close();
    await f.close();
  }
});

it("refuses protected admission before any external effect when its durable receipt path is unreadable", async () => {
  const f = await fixture(true);
  try {
    for (const name of ["message_seat", "hire_agent"]) {
      const result = await f.client.callTool({ name, arguments: { text: "must never dispatch" } });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toContain("unreadable");
      expect(await f.effects()).toEqual([]);
    }
    const read = await f.client.callTool({ name: "linear_get_issue", arguments: {} });
    expect(read.content).toEqual([{ type: "text", text: "VUH-1638 fixture issue" }]);
    expect(f.banks()).toBe(1);
    expect(f.closed()).toBe(false);
  } finally {
    await f.close();
  }
});

it.each(["message_seat", "hire_agent"])(
  "keeps the same stdio seat usable when the service restarts between %s calls",
  async (name) => {
    const f = await fixture();
    try {
      const pid = f.pid();
      const first = await f.client.callTool({ name, arguments: { text: "before restart" } });
      const before = await f.effects();
      expect(before).toHaveLength(1);
      expect(first.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            outcome: name === "message_seat" ? "delivered" : "started",
            ...(name === "message_seat" ? { deliveryId: before[0]!.id } : { hireId: before[0]!.id }),
            seatId: "fixture-seat",
          }),
        },
      ]);
      await f.restart();
      expect((await f.client.listTools()).tools.map((tool) => tool.name)).toContain(name);
      await f.secondBank;
      const second = await f.client.callTool({ name, arguments: { text: "after restart" } });
      const after = await f.effects();
      expect(after).toHaveLength(2);
      expect(second.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            outcome: name === "message_seat" ? "delivered" : "started",
            ...(name === "message_seat" ? { deliveryId: after[1]!.id } : { hireId: after[1]!.id }),
            seatId: "fixture-seat",
          }),
        },
      ]);
      expect(after[0]).toEqual(before[0]);
      expect(after[1]!.id).not.toBe(after[0]!.id);
      expect(f.banks()).toBe(2);
      expect(f.pid()).toBe(pid);
      expect(f.closed()).toBe(false);
    } finally {
      await f.close();
    }
  },
);
