import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore, type ProviderAccount } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, it } from "vitest";
import type { LocalFleetIdentity } from "../src/local-fleet-link.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function listen(fetch: (request: Request) => Promise<Response>) {
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing worker receipt fixture address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Real worker/host/SDK HTTP path; the isolated tracker owns one controlled issue. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-call-receipts-"));
  const admitted = gate();
  const release = gate();
  const observed = gate();
  const effects: Record<string, unknown>[] = [];
  const providerSessions = new Map<
    string,
    { server: Server; transport: WebStandardStreamableHTTPServerTransport }
  >();
  const provider = await listen(async (request) => {
    if (request.headers.get("authorization") !== "Bearer fixture-provider-secret")
      return new Response(null, { status: 401 });
    const id = request.headers.get("mcp-session-id");
    if (id) {
      const session = providerSessions.get(id);
      return session
        ? session.transport.handleRequest(request)
        : Response.json({ error: "unknown_session" }, { status: 404 });
    }
    const server = new Server(
      { name: "receipt-tracker-fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "save_issue",
          description: "Update the isolated fixture issue state.",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" }, state: { type: "string" } },
            required: ["id", "state"],
          },
        },
        { name: "read_large", inputSchema: { type: "object", properties: {} } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      if (call.params.name === "read_large") {
        admitted.release();
        await release.promise;
        return { content: [{ type: "text", text: "x".repeat(60_000) }], isError: false };
      }
      expect(call.params.name).toBe("save_issue");
      const args = call.params.arguments ?? {};
      const issue = {
        id: String(args.id),
        status: String(args.state),
        description: "Saved fixture description ".repeat(3_000),
        url: "https://linear.app/fixture/issue/VUH-FIXTURE",
      };
      effects.push(issue);
      admitted.release();
      await release.promise;
      return { content: [{ type: "text", text: JSON.stringify(issue) }], isError: false };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
    });
    await server.connect(transport as unknown as Transport);
    const response = await transport.handleRequest(request);
    if (transport.sessionId) providerSessions.set(transport.sessionId, { server, transport });
    return response;
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    fleet: { ...current.fleet, tools: "connected" },
    mcp: {
      ...current.mcp,
      servers: [
        {
          id: "linear",
          transport: "http",
          url: provider.url,
          args: [],
          lane: "operator",
          credential: "linear",
          initialTools: [],
          enabled: true,
        },
      ],
    },
  }));
  const account: ProviderAccount = {
    provider: "linear",
    connectionId: randomUUID(),
    userId: randomUUID(),
    workspaceId: randomUUID(),
    name: "Fixture app",
    actor: "app",
    workspaceName: "Receipt fixture",
    verifiedAt: new Date().toISOString(),
  };
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await credentials.set("linear", { type: "api", key: "fixture-provider-secret", account });
  const host = createMcpHost({
    credentials,
    settings,
    curated: [],
    logger: { info() {}, warn() {} },
    observeCall: () => observed.release(),
  });
  let valid = true;
  let authenticationFailure: Error | undefined;
  let heldFence: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  const options = {
    directory: join(root, "grants"),
    credentials,
    host,
    requestTimeoutMs: 500,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const held = heldFence;
      if (held) {
        heldFence = undefined;
        held.entered.release();
        await held.release.promise;
      }
      const tools = (await settings.load()).fleet.tools;
      return { tools, assertCurrent() {} };
    },
  };
  let worker = new WorkerMcp(options);
  const identity = (pane = "w1:p1"): LocalFleetIdentity => ({
    fleet: "default",
    pane,
    current: () => valid,
    validate: async () => {
      if (authenticationFailure) throw authenticationFailure;
      return valid;
    },
  });
  const service = await listen((request) =>
    worker.handleLocalFleet(request, identity(request.headers.get("x-fixture-pane") ?? "w1:p1")),
  );
  let sequence = 0;
  const bridgeId = randomUUID();
  const headers = (session?: string, pane = "w1:p1") => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-clankie-bridge-id": bridgeId,
    "x-fixture-pane": pane,
    ...(session ? { "mcp-session-id": session } : {}),
  });
  const body = (method: string, params: unknown) => ({ jsonrpc: "2.0", id: ++sequence, method, params });
  const post = (method: string, params: unknown, session?: string, pane?: string, signal?: AbortSignal) =>
    fetch(service.url, {
      method: "POST",
      headers: headers(session, pane),
      body: JSON.stringify(body(method, params)),
      signal: signal ?? AbortSignal.timeout(3_000),
    });
  const initialize = async (pane?: string) => {
    const response = await post(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "worker-receipt-fixture", version: "1" },
      },
      undefined,
      pane,
    );
    expect(response.status).toBe(200);
    await response.json();
    const session = response.headers.get("mcp-session-id")!;
    expect(session).toBeTruthy();
    const initialized = await fetch(service.url, {
      method: "POST",
      headers: headers(session, pane),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initialized.status).toBe(202);
    return session;
  };
  const call = async (args: unknown, session: string, pane?: string, receiptId?: string) => {
    const response = await post(
      "tools/call",
      {
        name: "clankie_call",
        arguments: args,
        ...(receiptId === undefined ? {} : { _meta: { clankieReceiptId: receiptId } }),
      },
      session,
      pane,
    );
    expect(response.status).toBe(200);
    const reply = await response.json();
    return { ...JSON.parse(reply.result.content[0].text), toolError: reply.result.isError };
  };
  cleanup.push(async () => {
    release.release();
    heldFence?.release.release();
    await worker.close();
    await host.close();
    await service.close();
    for (const session of providerSessions.values()) await session.server.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    call,
    post,
    initialize,
    status: () => worker.bridgeStatus("default", "w1:p1"),
    effects,
    admitted,
    release,
    observed,
    credentials,
    account,
    settings,
    holdFence() {
      const held = { entered: gate(), release: gate() };
      heldFence = held;
      return held;
    },
    failAuthentication(error: Error) {
      authenticationFailure = error;
    },
    async restartWorker() {
      await worker.close();
      worker = new WorkerMcp(options);
    },
    revoke() {
      valid = false;
    },
  };
}

const invocation = { name: "linear_save_issue", arguments: { id: "VUH-FIXTURE", state: "Done" } };

it("a timed-out admitted Linear write has a durable receipt and reconciles without redispatch", async () => {
  const f = await fixture();
  const session = await f.initialize();
  const catalogResponse = await f.post("tools/list", {}, session);
  const catalog = ListToolsResultSchema.parse((await catalogResponse.json()).result);
  expect(catalog.tools.map((tool) => tool.name)).toEqual(["clankie_tools", "clankie_call"]);
  expect(catalog.tools[1]?.inputSchema).toMatchObject({ type: "object", anyOf: expect.any(Array) });
  const started = Date.now();
  const pending = f.call(invocation, session);
  await f.admitted.promise;
  expect(f.effects).toHaveLength(1);
  const uncertain = await pending;
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(uncertain).toMatchObject({
    outcome: "uncertain",
    receiptId: expect.any(String),
    detail: "may have applied; reconcile, don’t retry",
    toolError: false,
    reason: expect.stringMatching(/timed out|timeout/iu),
  });
  expect(f.status()).toMatchObject({ status: "stalled" });
  expect(await f.call({ receiptId: uncertain.receiptId }, session)).toEqual(uncertain);
  f.release.release();
  await f.observed.promise;
  expect(f.status()).toMatchObject({ status: "ready" });
  const settled = await f.call({ receiptId: uncertain.receiptId }, session);
  expect(settled).toMatchObject({
    outcome: "ok",
    receiptId: uncertain.receiptId,
    isError: false,
    toolError: false,
  });
  expect(JSON.parse(settled.content)).toMatchObject({ id: "VUH-FIXTURE", status: "Done" });
  expect(settled.content.length).toBeLessThan(1_000);
  expect(JSON.parse(settled.content).description).toContain("chars saved");
  expect(f.effects).toHaveLength(1);
  await f.restartWorker();
  const restored = await f.initialize();
  expect(await f.call({ receiptId: uncertain.receiptId }, restored)).toEqual(settled);
  expect(await f.call({ receiptId: randomUUID() }, restored)).toMatchObject({
    outcome: "uncertain",
    toolError: false,
  });
  const otherPane = await f.initialize("w1:p2");
  expect(await f.call({ receiptId: uncertain.receiptId }, otherPane, "w1:p2")).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
  expect(await f.call({ receiptId: uncertain.receiptId }, restored)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "connected" } }));
  await f.credentials.set("linear", {
    type: "api",
    key: "fixture-provider-secret",
    account: { ...f.account, connectionId: randomUUID() },
  });
  expect(await f.call({ receiptId: uncertain.receiptId }, restored)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(f.effects).toHaveLength(1);
});

it("late read receipt reconciliation preserves the model-facing 50k content cap", async () => {
  const f = await fixture();
  const session = await f.initialize();
  const receiptId = randomUUID();
  const pending = f.call({ name: "linear_read_large", arguments: {} }, session, undefined, receiptId);
  await f.admitted.promise;
  expect(await pending).toMatchObject({ outcome: "uncertain", receiptId });
  f.release.release();
  await f.observed.promise;
  const settled = await f.call({ receiptId }, session);
  expect(settled).toMatchObject({ outcome: "ok", receiptId, isError: false });
  expect(settled.content).toBe("x".repeat(50_000));
  expect(f.effects).toHaveLength(0);
});

it("an admitted write settles durably after its receiving HTTP request is cancelled", async () => {
  const f = await fixture();
  const session = await f.initialize();
  const receiver = new AbortController();
  const receiptId = randomUUID();
  const pending = f
    .post(
      "tools/call",
      { name: "clankie_call", arguments: invocation, _meta: { clankieReceiptId: receiptId } },
      session,
      undefined,
      receiver.signal,
    )
    .catch((error: unknown) => error);
  await f.admitted.promise;
  receiver.abort();
  expect(await pending).toBeInstanceOf(Error);
  expect(await f.call({ receiptId }, session)).toMatchObject({ outcome: "uncertain", receiptId });
  f.release.release();
  await f.observed.promise;
  expect(await f.call({ receiptId }, session)).toMatchObject({ outcome: "ok", receiptId, isError: false });
  expect(f.effects).toHaveLength(1);
});

it("a supplied receipt ID admits one concurrent write and rejects changed inputs or authority", async () => {
  const f = await fixture();
  const session = await f.initialize();
  const receiptId = randomUUID();
  const pending = f.call(invocation, session, undefined, receiptId);
  const repeated = f.call(
    { arguments: { state: "Done", id: "VUH-FIXTURE" }, name: "linear_save_issue" },
    session,
    undefined,
    receiptId,
  );
  await f.admitted.promise;
  const uncertain = await pending;
  expect(uncertain).toMatchObject({ outcome: "uncertain", receiptId });
  expect(await repeated).toMatchObject({
    outcome: "uncertain",
    receiptId,
    detail: uncertain.detail,
    toolError: false,
  });
  expect(await f.call({ receiptId }, session)).toMatchObject({
    outcome: "uncertain",
    receiptId,
    reason: expect.stringMatching(/timed out|timeout/iu),
    toolError: false,
  });
  expect(
    await f.call(
      { name: "linear_save_issue", arguments: { id: "VUH-FIXTURE", state: "In Progress" } },
      session,
      undefined,
      receiptId,
    ),
  ).toMatchObject({ outcome: "refused", toolError: true });
  expect(await f.call(invocation, session, undefined, "not-a-uuid")).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(await f.call({ ...invocation, receiptId }, session)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  const otherPane = await f.initialize("w1:p2");
  expect(await f.call(invocation, otherPane, "w1:p2", receiptId)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(f.effects).toHaveLength(1);
  f.release.release();
  await f.observed.promise;
  const settled = await f.call({ receiptId }, session);
  expect(settled).toMatchObject({ outcome: "ok", receiptId, isError: false });
  expect(await f.call(invocation, session, undefined, receiptId)).toEqual(settled);
  await f.restartWorker();
  const restored = await f.initialize();
  expect(await f.call(invocation, restored, undefined, receiptId)).toEqual(settled);
  await f.credentials.set("linear", {
    type: "api",
    key: "fixture-provider-secret",
    account: { ...f.account, connectionId: randomUUID() },
  });
  expect(await f.call(invocation, restored, undefined, receiptId)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(f.effects).toHaveLength(1);
});

it("an expired pre-dispatch fence cannot mutate the provider after its delayed read releases", async () => {
  const f = await fixture();
  const session = await f.initialize();
  const held = f.holdFence();
  const receiptId = randomUUID();
  const pending = f.call(invocation, session, undefined, receiptId);
  await held.entered.promise;
  expect(await f.call({ receiptId }, session)).toMatchObject({
    outcome: "uncertain",
    receiptId,
    toolError: false,
  });
  expect(await pending).toMatchObject({ outcome: "refused", toolError: true });
  held.release.release();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(f.effects).toHaveLength(0);
  expect(await f.call({ receiptId }, session)).toMatchObject({
    outcome: "uncertain",
    receiptId,
    toolError: false,
  });
});

it("a missing receipt during original setup stays uncertain until the original applies once", async () => {
  const f = await fixture();
  const session = await f.initialize();
  const held = f.holdFence();
  const receiptId = randomUUID();
  const pending = f.call(invocation, session, undefined, receiptId);
  await held.entered.promise;
  expect(await f.call({ receiptId }, session)).toMatchObject({
    outcome: "uncertain",
    receiptId,
    toolError: false,
  });
  expect(f.effects).toHaveLength(0);
  f.release.release();
  held.release.release();
  const settled = await pending;
  expect(settled).toMatchObject({ outcome: "ok", receiptId, toolError: false });
  expect(await f.call({ receiptId }, session)).toEqual(settled);
  expect(f.effects).toHaveLength(1);
});

it("unauthenticated worker failures do not expose internal authentication details", async () => {
  const f = await fixture();
  f.failAuthentication(new Error("private authority backend failure fixture-secret"));
  const response = await f.post("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "worker_grant_unavailable",
    reason: "Worker access unavailable",
  });
  expect(f.effects).toHaveLength(0);
});
