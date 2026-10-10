import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { LocalFleetLink, type LocalFleetProofRequestContext } from "../src/local-fleet-link.ts";
import { clientPid } from "../src/local-fleet-proof.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

const exec = promisify(execFile);
const localIt = it.skipIf(process.platform !== "darwin");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-local-mcp-"));
  const state = { admitted: true, revokeDuringDiscovery: false, dispatched: 0 };
  const provider = new Server({ name: "fixture-provider", version: "1" }, { capabilities: { tools: {} } });
  provider.setRequestHandler(ListToolsRequestSchema, async () => {
    if (state.revokeDuringDiscovery) state.admitted = false;
    return {
      tools: [
        {
          name: "read",
          description: "Read fixture data",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
    };
  });
  provider.setRequestHandler(CallToolRequestSchema, async () => {
    state.dispatched++;
    return { content: [{ type: "text", text: "fixture result" }] };
  });
  const providerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  await provider.connect(providerTransport);
  const providerHttp = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => providerTransport.handleRequest(request),
  });
  await new Promise<void>((resolve) =>
    providerHttp.listening ? resolve() : providerHttp.once("listening", resolve),
  );
  const providerAddress = providerHttp.address();
  if (!providerAddress || typeof providerAddress === "string") throw new Error("Missing provider listener");
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await credentials.set("fixture", {
    type: "api",
    key: "fixture-only",
    account: {
      provider: "linear",
      actor: "app",
      connectionId: randomUUID(),
      userId: "fixture",
      workspaceId: "fixture",
      name: "Fixture",
      workspaceName: "Fixture",
      verifiedAt: new Date().toISOString(),
    },
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((value) => ({
    ...value,
    mcp: {
      ...value.mcp,
      servers: [
        {
          id: "fixture",
          credential: "fixture",
          transport: "http",
          url: `http://127.0.0.1:${providerAddress.port}/mcp`,
          lane: "operator",
          args: [],
          initialTools: [],
          enabled: true,
        },
      ],
    },
  }));
  const host = createMcpHost({ settings, credentials, curated: [], logger: { info() {}, warn() {} } });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const snapshot = await settings.loadFenced();
      return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
    },
  });
  const observedPorts: number[] = [];
  const proofContexts: LocalFleetProofRequestContext[] = [];
  const local = new LocalFleetLink({
    directory: join(root, "links"),
    binding: async () => undefined,
    // The temporary controller admits only its own fixture client process and
    // exact pane. This uses real TCP kernel ownership, not caller PID claims;
    // ordinary native Herdr ancestry is exercised by the manual ABI journey.
    prove: async (socket, pane, _signal, context) => {
      if (!context || context.socket !== socket) throw new Error("Missing request/socket attribution");
      proofContexts.push(context);
      // Count every fresh proof, including a refusal after provider discovery.
      observedPorts.push(socket.remotePort ?? 0);
      if (!state.admitted || pane !== "w1:p1" || socket.destroyed || !socket.remotePort || !socket.localPort)
        return false;
      const { stdout } = await exec(
        "/usr/sbin/lsof",
        ["-nP", "-a", `-iTCP:${socket.localPort}`, "-sTCP:ESTABLISHED", "-Fpn"],
        { timeout: 5000 },
      );
      return (
        state.admitted &&
        !socket.destroyed &&
        clientPid(stdout, socket.remotePort, socket.localPort) === process.pid
      );
    },
  });
  const listener = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: local.fetch(async (request) => {
      const identity = local.identity(request);
      return identity
        ? worker.handleLocalFleet(request, identity)
        : Response.json({ error: "missing_identity" }, { status: 403 });
    }),
  });
  await new Promise<void>((resolve) =>
    listener.listening ? resolve() : listener.once("listening", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing local listener");
  const endpoint = `http://127.0.0.1:${address.port}/v1/fleet/mcp`;
  const bridgeId = randomUUID();
  let id = 0;
  async function rpc(
    method: string,
    params: unknown = {},
    options: { pane?: string; session?: string; close?: boolean; bridgeId?: string } = {},
  ) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-clankie-pane": options.pane ?? "w1:p1",
        "x-clankie-bridge-id": options.bridgeId ?? bridgeId,
        ...(options.session ? { "mcp-session-id": options.session } : {}),
        ...(options.close ? { connection: "close" } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      // Successful calls cross all fresh OS proofs; stay below the worker's 30s budget.
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : undefined };
  }
  const initialize = (close = false) =>
    rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fixture-native-client", version: "1" },
      },
      { close },
    );
  return {
    state,
    observedPorts,
    proofContexts,
    bridgeId,
    rpc,
    initialize,
    close: async () => {
      await local.close();
      await worker.close();
      await host.close();
      await provider.close();
      if (listener instanceof HttpServer) listener.closeAllConnections();
      if (providerHttp instanceof HttpServer) providerHttp.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => listener.close(() => resolve())),
        new Promise<void>((resolve) => providerHttp.close(() => resolve())),
      ]);
      await rm(root, { recursive: true, force: true });
    },
  };
}

localIt(
  "refuses nonmembers at current MCP authentication before initialize and call, preserving the public refusal",
  async () => {
    const f = await fixture();
    try {
      f.state.admitted = false;
      for (const method of ["initialize", "tools/call"]) {
        const result = await f.rpc(method);
        expect(result.response.status).toBe(403);
        expect(result.body).toEqual({ error: "local_process_membership_required" });
      }
      const malformed = await f.rpc("initialize", {}, { bridgeId: "not-a-uuid-secret" });
      expect(malformed.response.status).toBe(403);
      expect(f.proofContexts.at(-1)?.bridgeId).toBeUndefined();
      f.state.admitted = true;
      expect((await f.rpc("initialize", {}, { pane: "w0:p0" })).response.status).toBe(403);
      const proofsBeforeInitialize = f.observedPorts.length;
      expect((await f.initialize()).response.status).toBe(200);
      expect(f.observedPorts.length - proofsBeforeInitialize).toBe(1);
      expect(f.state.dispatched).toBe(0);
    } finally {
      await f.close();
    }
  },
);

localIt("reauthenticates the current HTTP socket after the initialize socket closes", async () => {
  const f = await fixture();
  try {
    const init = await f.initialize(true);
    expect(init.response.status).toBe(200);
    expect.soft(f.observedPorts).toHaveLength(1);
    const initialPort = f.observedPorts[0];
    const initialContext = f.proofContexts[0]!;
    const session = init.response.headers.get("mcp-session-id")!;
    const proofsBeforeList = f.observedPorts.length;
    const listed = await f.rpc("tools/list", {}, { session });
    expect(listed.response.status).toBe(200);
    // The HTTP boundary admits the current request once; discovery reuses it.
    expect.soft(f.observedPorts.length - proofsBeforeList).toBe(1);
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "clankie_tools",
      "clankie_call",
    ]);
    expect(f.observedPorts.slice(proofsBeforeList).every((port) => port !== initialPort)).toBe(true);
    const listContexts = f.proofContexts.slice(proofsBeforeList);
    expect(new Set(listContexts.map((context) => context.requestId)).size).toBe(1);
    expect(new Set(listContexts.map((context) => context.connectionId)).size).toBe(1);
    expect(listContexts[0]!.requestId).not.toBe(initialContext.requestId);
    expect(listContexts[0]!.connectionId).not.toBe(initialContext.connectionId);
    for (const context of [initialContext, ...listContexts]) {
      const { socket: _socket, ...attribution } = context;
      expect(attribution).toEqual({
        requestId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
        connectionId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
        route: "mcp",
        method: "POST",
        bridgeId: f.bridgeId,
      });
    }
    f.state.admitted = false;
    const revoked = await f.rpc("tools/list", {}, { session });
    expect(revoked.response.status).toBe(403);
    expect(revoked.body).toEqual({ error: "local_process_membership_required" });
  } finally {
    await f.close();
  }
});

localIt("rechecks admission after real provider discovery before dispatching a connected call", async () => {
  const f = await fixture();
  try {
    const init = await f.initialize();
    expect(init.response.status).toBe(200);
    expect.soft(f.observedPorts).toHaveLength(1);
    const session = init.response.headers.get("mcp-session-id")!;
    f.state.revokeDuringDiscovery = true;
    const proofsBeforeCall = f.observedPorts.length;
    const called = await f.rpc(
      "tools/call",
      { name: "clankie_call", arguments: { name: "fixture_read", arguments: {} } },
      { session },
    );
    expect(called.body.result.isError).toBe(true);
    expect(JSON.stringify(called.body)).toContain("Fleet admission unavailable");
    // Both authentication checks, then the refusal after provider discovery.
    expect.soft(f.observedPorts.length - proofsBeforeCall).toBe(3);
    expect(f.state.dispatched).toBe(0);
  } finally {
    await f.close();
  }
});

localIt("dispatches an admitted connected call through the real provider boundary", async () => {
  const f = await fixture();
  try {
    const init = await f.initialize();
    expect(init.response.status).toBe(200);
    expect.soft(f.observedPorts).toHaveLength(1);
    const session = init.response.headers.get("mcp-session-id")!;
    const proofsBeforeCall = f.observedPorts.length;
    const called = await f.rpc(
      "tools/call",
      { name: "clankie_call", arguments: { name: "fixture_read", arguments: {} } },
      { session },
    );
    expect(called.response.status).toBe(200);
    expect(called.body.result.isError).toBe(false);
    expect(JSON.stringify(called.body)).toContain("fixture result");
    expect(f.state.dispatched).toBe(1);
    // HTTP/SDK authentication, post-discovery admission, and the final host fence.
    expect.soft(f.observedPorts.length - proofsBeforeCall).toBe(4);
  } finally {
    await f.close();
  }
});
