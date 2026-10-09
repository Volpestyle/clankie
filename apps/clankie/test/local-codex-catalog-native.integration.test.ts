// Explicit native boundary check: CODEX_CATALOG_NATIVE_TEST=1. Real binary, offline model transport.
// No owner credentials, existing controllers, native pane input or service deploys.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import { readLocalCodexRecords } from "../src/local-codex-records.ts";
import { CodexAppServerClient, openCodexSocket } from "../src/captain/codex-app-server.ts";
import { createLocalCodexCatalogCoordinator } from "../src/captain/local-codex-catalog-coordinator.ts";
import { codexToolCatalogReport } from "../../../integrations/claude-plugin/worker/bin/codex-tool-catalog.mjs";

const nativeIt = it.skipIf(process.platform === "win32" || process.env.CODEX_CATALOG_NATIVE_TEST !== "1");
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const names = [
  "clankie_call",
  "clankie_tools",
  "list_fleet_seats",
  "message_clankie",
  "message_clankie_status",
  "message_peer",
];
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
function modelToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const tool = object(entry);
    if (tool.type === "namespace") return modelToolNames(tool.tools);
    return tool.type === "function" && typeof tool.name === "string" ? [tool.name.split("__").at(-1)!] : [];
  });
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function nativeFixture(options: { omitModelTools?: boolean; launchOnlyBridge?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-catalog-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "worker-codex", "seat-native"),
    bin = join(root, "bin"),
    state = join(root, "state"),
    socketPath = join(root, "rpc.sock"),
    recordsPath = join(root, "seats.json"),
    configPath = join(home, "config.toml");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  await mkdir(join(state, "links"), { recursive: true, mode: 0o700 });
  const bridge = join(import.meta.dirname, "helpers/codex-catalog-native-bridge.mjs");
  await writeFile(join(bin, "clankie"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(bridge)}\n`, {
    mode: 0o700,
  });
  let available = false,
    delayMs = 0,
    toolCalls = 0;
  const modelRequests: Record<string, unknown>[] = [];
  const transports = new Set<StreamableHTTPServerTransport>();
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Set<Server>();
  const http = createServer((request, response) => {
    void (async () => {
      if (request.url === "/unused-model/responses") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        modelRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
        const id = `owned-response-${modelRequests.length}`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id } },
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              role: "assistant",
              id: `${id}-message`,
              content: [{ type: "output_text", text: "Owned offline turn completed." }],
            },
          },
          {
            type: "response.completed",
            response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
          },
        ])
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
        return;
      }
      if (request.url !== "/v1/fleet/mcp") {
        if (request.url?.endsWith("/messages") && request.method === "POST") toolCalls++;
        response.writeHead(404).end("{}");
        return;
      }
      if (!available) {
        response.writeHead(503).end(JSON.stringify({ error: "owned_catalog_startup_outage" }));
        return;
      }
      const sessionId = request.headers["mcp-session-id"];
      const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(request, response);
        return;
      }
      const server = new Server(
        { name: "owned-fleet-catalog", version: "1" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return {
          tools: ["clankie_tools", "clankie_call"].map((name) => ({
            name,
            inputSchema: { type: "object" as const },
          })),
          _meta: {
            clankie: {
              tools: "connected",
              peerMessages: "on",
              runtimeRevision: "owned-runtime",
              pluginVersion: "0.6.9",
            },
          },
        };
      });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        toolCalls++;
        return { content: [{ type: "text", text: "Owned test tool was called" }] };
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
        enableJsonResponse: true,
      });
      transports.add(transport);
      servers.add(server);
      // SDK callback declarations do not implement exactOptionalPropertyTypes;
      // use the same boundary cast as Clankie's production MCP servers.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response);
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const transport of transports) await transport.close();
    for (const server of servers) await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const port = (http.address() as { port: number }).port;
  await writeFile(
    join(state, "links", "owned.json"),
    JSON.stringify({
      schemaVersion: 2,
      authentication: "local-process",
      fleet: "owned",
      socket: "owned-herdr",
      url: `http://127.0.0.1:${port}`,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    configPath,
    `model = "owned-model"\nmodel_provider = "owned"\n[mcp_servers.clankie]\ncommand = "clankie"\nargs = ["mcp", "--fleet"]\nenv_vars = ["CLANKIE_STATE", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"]\nenv = { CLANKIE_EXPECTED_TOOL_NAMES = '${JSON.stringify(names)}' }\nstartup_timeout_sec = 10\n${options.omitModelTools ? 'omit_tools_from = ["code_mode", "deferred", "direct"]\n' : ""}[model_providers.owned]\nname = "Owned offline provider"\nbase_url = "http://127.0.0.1:${port}/unused-model"\nwire_api = "responses"\n`,
    { mode: 0o600 },
  );
  const overrides = options.launchOnlyBridge
    ? [
        "mcp_servers.clankie.enabled=false",
        "mcp_servers.worker.enabled=true",
        'mcp_servers.worker.command="clankie"',
        'mcp_servers.worker.args=["mcp","--fleet"]',
        'mcp_servers.worker.env_vars=["CLANKIE_STATE","HERDR_SOCKET_PATH","HERDR_PANE_ID"]',
        `mcp_servers.worker.env.CLANKIE_EXPECTED_TOOL_NAMES=${JSON.stringify(JSON.stringify(names))}`,
        "mcp_servers.worker.startup_timeout_sec=10",
      ]
    : [];
  const child = spawn(
    "codex",
    [...overrides.flatMap((value) => ["-c", value]), "app-server", "--listen", `unix://${socketPath}`],
    {
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLANKIE_STATE: state,
        HERDR_SOCKET_PATH: "owned-herdr",
        HERDR_PANE_ID: "w1:p1",
        PATH: `${bin}:${process.env.PATH}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "",
    spawnError: Error | undefined;
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + String(bytes)).slice(-8000);
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  cleanups.push(async () => {
    if (child.exitCode !== null || spawnError) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  });
  let socket: Awaited<ReturnType<typeof openCodexSocket>>;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (spawnError || child.exitCode !== null)
      throw new Error(`Native Codex unavailable: ${spawnError ?? stderr}`);
    socket = await openCodexSocket(`ws+unix://${socketPath}:/`);
    if (socket) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!socket!) throw new Error(`Native socket unavailable: ${stderr}`);
  await chmod(socketPath, 0o600);
  const completedTurns = new Set<string>();
  const client = new CodexAppServerClient(
    socket!,
    (event) => {
      if (event.method === "turn/completed") completedTurns.add(String(object(event.params.turn).id));
    },
    15_000,
  );
  cleanups.push(() => client.close());
  await client.initialize(true);
  const request = (method: string, params: Record<string, unknown>) => client.request(method, params);
  const started = object(await request("thread/start", { cwd: root, ephemeral: true }));
  const threadId = String(object(started.thread).id);
  let occupant: string | undefined;
  const binding = { runtime: "external" as const, session: "owned", socketPath: join(root, "herdr.sock") };
  const registry = () =>
    new LocalCodexSeats(
      () => binding,
      async () => "owned-birth",
      { path: recordsPath, observeOccupant: async () => occupant },
    );
  let seats = registry();
  await seats.register(child.pid!, "w1:p1").bindSession!(threadId, `unix://${socketPath}`);
  occupant = readLocalCodexRecords(recordsPath)[0]!.nativeOccupantId;
  const coordinators: ReturnType<typeof createLocalCodexCatalogCoordinator>[] = [];
  cleanups.push(() => {
    for (const coordinator of coordinators) coordinator.close();
  });
  const coordinator = () => {
    const value = createLocalCodexCatalogCoordinator({
      seats,
      expectedTools: () => names,
      intervalMs: 60_000,
      // Only process/pane authority is an owned fixture. Native protocol,
      // config layers, runtime startup and catalogs are the actual Codex binary.
      observeIdentity: async () => ({
        proof: { pid: child.pid, threadId, socketPath },
        endpoint: `unix://${socketPath}`,
        assertCurrent() {
          if (child.exitCode !== null) throw new Error("owned_codex_exited");
        },
      }),
    });
    coordinators.push(value);
    return value;
  };
  return {
    root,
    threadId,
    request,
    async turn() {
      const started = object(
        await request("turn/start", {
          threadId,
          input: [{ type: "text", text: "Owned offline catalog turn.", text_elements: [] }],
        }),
      );
      const turnId = String(object(started.turn).id);
      await expect.poll(() => completedTurns.has(turnId), { timeout: 15_000 }).toBe(true);
      return modelRequests.at(-1)!;
    },
    coordinator,
    toolCalls: () => toolCalls,
    available(value: boolean, delay = 0) {
      available = value;
      delayMs = delay;
    },
    restartRegistry() {
      seats = registry();
    },
  };
}

nativeIt(
  "repairs a confirmed startup failure with a fresh generation on the original real Codex thread",
  async () => {
    const f = await nativeFixture({ launchOnlyBridge: true }),
      first = f.coordinator();
    const before = await codexToolCatalogReport({
      sessionId: f.threadId,
      request: f.request,
      requireConnected: true,
    });
    expect(before.error).toContain("disconnected or rejected");
    // The pre-migration env-only write cannot register a launch-only server.
    await expect(
      f.request("config/value/write", {
        keyPath: "mcp_servers.worker.env.CLANKIE_CATALOG_REVISION",
        value: "old-env-only-write",
        mergeStrategy: "upsert",
      }),
    ).rejects.toThrow();
    expect(modelToolNames((await f.turn()).tools)).not.toContain("clankie_tools");
    expect(await first.refresh({ revision: "deploy-one" })).toMatchObject([
      {
        outcome: "failed",
        reason: "original_codex_catalog_unverified",
        detail: expect.stringContaining('"runtimeStatus":"failed"'),
      },
    ]);
    const directory = join(f.root, "codex-catalog-refresh"),
      journal = join(directory, (await readdir(directory)).find((name) => name.endsWith(".json"))!);
    const failed = JSON.parse(await readFile(journal, "utf8"));
    expect(failed).toMatchObject({ writeConfirmed: true, reloadConfirmed: true, verified: false });
    first.close();
    f.restartRegistry();
    const next = f.coordinator();
    // Read-only reconciliation remains read-only even after definitive failure.
    expect(await next.reconcile({ revision: "deploy-one" })).toMatchObject([{ outcome: "failed" }]);
    expect(JSON.parse(await readFile(journal, "utf8"))).toEqual(failed);
    f.available(true, 2_500);
    const repaired = await next.refresh({ revision: "deploy-one" });
    expect(repaired, JSON.stringify(repaired)).toMatchObject([
      {
        outcome: "catalog-refreshed",
        threadId: f.threadId,
        catalogs: [{ threadId: f.threadId, tools: names }],
      },
    ]);
    const confirmed = JSON.parse(await readFile(journal, "utf8"));
    expect(confirmed.envRevision).not.toBe(failed.envRevision);
    expect(confirmed.verified).toBe(true);
    expect(
      JSON.parse(await readFile(`${journal}.${failed.envRevision}.confirmed-failure.json`, "utf8")),
    ).toEqual(failed);
    expect(await f.request("thread/loaded/list", {})).toEqual({ data: [f.threadId], nextCursor: null });
    const nextTurn = await f.turn();
    expect(modelToolNames(nextTurn.tools)).toEqual(expect.arrayContaining(names));
    expect(f.toolCalls()).toBe(0);
  },
  60_000,
);

nativeIt(
  "does not certify model delivery from a connected catalog whose tools Codex omits from the next turn",
  async () => {
    const f = await nativeFixture({ omitModelTools: true });
    f.available(true);
    const refreshed = await f.coordinator().refresh({ revision: "catalog-only" });
    const catalog = await codexToolCatalogReport({
      sessionId: f.threadId,
      request: f.request,
      requireConnected: true,
    });
    expect(catalog.error).toBeUndefined();
    expect(catalog.tools).toEqual(names);
    const nextTurn = await f.turn();
    expect(modelToolNames(nextTurn.tools)).not.toContain("clankie_tools");
    expect(modelToolNames(nextTurn.tools)).not.toContain("message_clankie");
    expect(refreshed).toMatchObject([
      { outcome: "catalog-refreshed", reason: "original_codex_next_turn_tools_unverified" },
    ]);
    expect(await f.request("thread/loaded/list", {})).toEqual({ data: [f.threadId], nextCursor: null });
    expect(f.toolCalls()).toBe(0);
  },
  60_000,
);

nativeIt(
  "refuses a genuinely independent loaded root before mutation and reports its native inventory",
  async () => {
    const f = await nativeFixture();
    f.available(true);
    const other = object(await f.request("thread/start", { cwd: f.root, ephemeral: true })),
      otherId = String(object(other.thread).id);
    const result = await f.coordinator().refresh({ revision: "deploy-two" });
    expect(result).toMatchObject([
      {
        outcome: "failed",
        reason: "independent_codex_loaded_root",
        detail: expect.stringContaining(otherId),
      },
    ]);
    expect(result[0]!.detail).toContain(f.threadId);
    await expect(readdir(join(f.root, "codex-catalog-refresh"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.toolCalls()).toBe(0);
  },
  60_000,
);
