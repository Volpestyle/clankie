import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  FileCredentialStore,
  LINEAR_API_PROVIDER_ID,
  type ProviderAccount,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker } from "@clankie/work-items";
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
import { createAccounts } from "../src/accounts.ts";
import { createLinearApiTracker } from "../src/linear-api-tracker.ts";
import { createLinearApiProvider, DOCUMENT_ID, ISSUE_ID } from "./fixtures/linear-api-provider.ts";

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
async function fixture(options: { local?: boolean; api?: boolean } = {}) {
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
      servers: options.local
        ? []
        : [
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
  const apiProvider = options.api ? await createLinearApiProvider() : undefined;
  if (apiProvider) {
    const accounts = createAccounts({
      store: credentials,
      apps: async () => ({
        github: {},
        linear: {
          clientId: "registered-client",
          redirectUri: "https://gateway.test/account/connections/callback",
        },
      }),
      fetch: apiProvider.fetch,
    });
    const start = await accounts.startLinear();
    if (!start.ok) throw new Error("Missing API receipt OAuth flow");
    expect((await accounts.completeLinear(start.flowId, "good-code")).ok).toBe(true);
  } else if (!options.local) {
    await credentials.set("linear", { type: "api", key: "fixture-provider-secret", account });
  }
  const localTracker = options.local
    ? createLocalTracker({ directory: join(root, "local-tracker") })
    : undefined;
  const host = createMcpHost({
    credentials,
    settings,
    curated: [],
    ...(localTracker ? { localTracker, trackerIdentity: join(root, "local-tracker") } : {}),
    ...(apiProvider
      ? {
          linearApiTracker: createLinearApiTracker({ credentials, fetch: apiProvider.fetch }),
          linearFetch: apiProvider.fetch,
        }
      : {}),
    logger: { info() {}, warn() {} },
    observeCall: () => observed.release(),
  });
  let valid = true;
  let authenticationFailure: Error | undefined;
  let heldFence: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  const workerOptions = {
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
  let worker = new WorkerMcp(workerOptions);
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
    await apiProvider?.close();
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
    localTracker,
    apiProvider,
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
      worker = new WorkerMcp(workerOptions);
    },
    revoke() {
      valid = false;
    },
  };
}

const invocation = { name: "linear_save_issue", arguments: { id: "VUH-FIXTURE", state: "Done" } };

it("API-owned reads and writes retain scoped worker receipts without repeating provider calls", async () => {
  const f = await fixture({ api: true });
  const session = await f.initialize();
  const readId = randomUUID();
  const readArgs = { name: "linear_get_issue", arguments: { id: ISSUE_ID } };
  const read = await f.call(readArgs, session, undefined, readId);
  expect(read).toMatchObject({ outcome: "ok", receiptId: readId, isError: false, toolError: false });
  const reads = f.apiProvider!.seen.length;
  expect(await f.call({ receiptId: readId }, session)).toEqual(read);
  expect(await f.call(readArgs, session, undefined, readId)).toEqual(read);
  expect(f.apiProvider!.seen).toHaveLength(reads);
  const writeId = randomUUID();
  const writeArgs = {
    name: "linear_save_comment",
    arguments: { issueId: ISSUE_ID, body: "One API receipt" },
  };
  const write = await f.call(writeArgs, session, undefined, writeId);
  expect(write).toMatchObject({ outcome: "ok", receiptId: writeId, isError: false, toolError: false });
  expect(await f.call(writeArgs, session, undefined, writeId)).toEqual(write);
  expect(await f.call({ receiptId: writeId }, session)).toEqual(write);
  const writes = () =>
    f.apiProvider!.seen.filter((entry) => entry.query?.startsWith("mutation TrackerWrite"));
  expect(writes()).toHaveLength(1);
  expect(f.apiProvider!.rows.comments!.filter((row) => row.body === "One API receipt")).toHaveLength(1);
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
  expect(await f.call({ receiptId: readId }, session)).toMatchObject({ outcome: "refused", toolError: true });
  expect(await f.call(writeArgs, session, undefined, randomUUID())).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "connected" } }));
  await f.credentials.update(LINEAR_API_PROVIDER_ID, async (current) => {
    if (current.type !== "oauth" || !current.account) throw new Error("Expected connected API account");
    return { ...current, account: { ...current.account, connectionId: randomUUID() } };
  });
  expect(await f.call({ receiptId: readId }, session)).toMatchObject({ outcome: "refused", toolError: true });
  expect(await f.call({ receiptId: writeId }, session)).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(writes()).toHaveLength(1);
  expect(f.apiProvider!.validationErrors).toEqual([]);
});

it("a late API-owned read settles the same receipt with the model cap and no mutation admission", async () => {
  const f = await fixture({ api: true });
  const session = await f.initialize();
  f.apiProvider!.issue.description = "x".repeat(60_000);
  const held = f.apiProvider!.blockNextGraphql();
  const receiptId = randomUUID();
  try {
    const pending = f.call(
      { name: "linear_get_issue", arguments: { id: ISSUE_ID } },
      session,
      undefined,
      receiptId,
    );
    await held.started;
    const refused = await pending;
    expect(refused).toMatchObject({ outcome: "refused", toolError: true });
    // Both layers share the caller's deadline. Require the exact timeout
    // contract of whichever timer settles first, never an unrelated refusal.
    if (refused.reason === "worker_request_failed")
      expect(refused.detail).toBe(
        "Worker tool call timed out or was cancelled: TimeoutError: The operation was aborted due to timeout",
      );
    else {
      expect(refused.reason).toBe("server_unavailable");
      expect(refused.detail).toMatch(/^MCP linear\/get_issue timed out after ([1-9]\d{0,2})ms$/u);
      expect(Number(refused.detail.match(/after (\d+)ms$/u)?.[1])).toBeLessThanOrEqual(500);
    }
    held.release();
    await f.observed.promise;
    const count = f.apiProvider!.seen.length;
    const settled = await f.call({ receiptId }, session);
    expect(settled).toMatchObject({ outcome: "ok", receiptId, isError: false, toolError: false });
    expect(settled.content).toHaveLength(50_000);
    expect(await f.call({ receiptId }, session)).toEqual(settled);
    expect(f.apiProvider!.seen).toHaveLength(count);
    expect(f.apiProvider!.seen.some((entry) => entry.query?.startsWith("mutation"))).toBe(false);
  } finally {
    held.release();
    // The original API response owns its journal settlement after caller timeout.
    // Drain it before fixture cleanup removes the receipt directory.
    await f.observed.promise;
  }
});

it("an admitted API mutation keeps an uncertain receipt until its original response settles", async () => {
  const f = await fixture({ api: true });
  const session = await f.initialize();
  const held = f.apiProvider!.blockNextMutationResponse();
  const receiptId = randomUUID();
  const args = {
    name: "linear_save_comment",
    arguments: { issueId: ISSUE_ID, body: "One delayed API effect" },
  };
  try {
    const pending = f.call(args, session, undefined, receiptId);
    await held.started;
    expect(f.apiProvider!.rows.comments!.filter((row) => row.body === args.arguments.body)).toHaveLength(1);
    expect(await pending).toMatchObject({ outcome: "uncertain", receiptId, toolError: false });
    expect(await f.call({ receiptId }, session)).toMatchObject({
      outcome: "uncertain",
      receiptId,
      toolError: false,
    });
    expect(await f.call(args, session, undefined, receiptId)).toMatchObject({
      outcome: "uncertain",
      receiptId,
      toolError: false,
    });
    held.release();
    await f.observed.promise;
    const settled = await f.call({ receiptId }, session);
    expect(settled).toMatchObject({ outcome: "ok", receiptId, isError: false, toolError: false });
    await f.restartWorker();
    expect(await f.call({ receiptId }, await f.initialize())).toEqual(settled);
    expect(
      f.apiProvider!.seen.filter((entry) => entry.query?.startsWith("mutation TrackerWrite")),
    ).toHaveLength(1);
    expect(f.apiProvider!.rows.comments!.filter((row) => row.body === args.arguments.body)).toHaveLength(1);
    expect(f.apiProvider!.validationErrors).toEqual([]);
  } finally {
    held.release();
  }
});

const removeScratch = {
  name: "linear_graphql",
  arguments: {
    query: "mutation Remove($id: String!) { documentDelete(id: $id) { success } }",
    variables: { id: DOCUMENT_ID },
  },
};
const confirmedRemoval = {
  ...removeScratch,
  arguments: { ...removeScratch.arguments, confirm: [DOCUMENT_ID] },
};

it("a fleet worker queries and deletes a scratch document through linear_graphql with one durable receipt", async () => {
  const f = await fixture({ api: true });
  const session = await f.initialize();
  const deletes = () => f.apiProvider!.seen.filter((entry) => entry.query?.includes("documentDelete"));
  expect(await f.call(removeScratch, session)).toMatchObject({
    outcome: "refused",
    reason: "confirmation_required",
    toolError: true,
  });
  const read = await f.call(
    {
      name: "linear_graphql",
      arguments: {
        query: "query Scratch($id: String!) { document(id: $id) { id title } }",
        variables: { id: DOCUMENT_ID },
      },
    },
    session,
  );
  expect(read).toMatchObject({ outcome: "ok", isError: false, toolError: false });
  expect(JSON.parse(read.content)).toMatchObject({ data: { document: { id: DOCUMENT_ID } } });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
  expect(await f.call(confirmedRemoval, session)).toMatchObject({ outcome: "refused", toolError: true });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "connected" } }));
  expect(deletes()).toHaveLength(0);
  const receiptId = randomUUID();
  const removed = await f.call(confirmedRemoval, session, undefined, receiptId);
  expect(removed).toMatchObject({ outcome: "ok", receiptId, isError: false, toolError: false });
  expect(await f.call(confirmedRemoval, session, undefined, receiptId)).toEqual(removed);
  expect(await f.call({ receiptId }, session)).toEqual(removed);
  expect(deletes()).toHaveLength(1);
  expect(f.apiProvider!.rows.documents).toEqual([]);
  expect(f.apiProvider!.validationErrors).toEqual([]);
});

it("an uncertain linear_graphql mutation reconciles by receipt and is never resent", async () => {
  const f = await fixture({ api: true });
  const session = await f.initialize();
  const held = f.apiProvider!.blockNextMutationResponse();
  const receiptId = randomUUID();
  try {
    const pending = f.call(confirmedRemoval, session, undefined, receiptId);
    await held.started;
    expect(await pending).toMatchObject({ outcome: "uncertain", receiptId, toolError: false });
    expect(await f.call(confirmedRemoval, session, undefined, receiptId)).toMatchObject({
      outcome: "uncertain",
      receiptId,
    });
    held.release();
    await f.observed.promise;
    expect(await f.call({ receiptId }, session)).toMatchObject({
      outcome: "ok",
      receiptId,
      isError: false,
      toolError: false,
    });
    expect(f.apiProvider!.seen.filter((entry) => entry.query?.includes("documentDelete"))).toHaveLength(1);
    expect(f.apiProvider!.rows.documents).toEqual([]);
  } finally {
    held.release();
  }
});

it.each(["off", "account"] as const)(
  "refuses an API write when %s changes during its target lookup",
  async (change) => {
    const f = await fixture({ api: true });
    const session = await f.initialize();
    const held = f.apiProvider!.blockNextGraphql();
    try {
      const pending = f.call(
        { name: "linear_save_comment", arguments: { issueId: ISSUE_ID, body: "Refused API effect" } },
        session,
      );
      await held.started;
      if (change === "off") {
        await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
      } else {
        await f.credentials.update(LINEAR_API_PROVIDER_ID, async (current) => {
          if (current.type !== "oauth" || !current.account) throw new Error("Expected connected API account");
          return { ...current, account: { ...current.account, connectionId: randomUUID() } };
        });
      }
      held.release();
      expect(await pending).toMatchObject({ outcome: "refused", toolError: true });
      expect(f.apiProvider!.seen.some((entry) => entry.query?.startsWith("mutation"))).toBe(false);
      expect(f.apiProvider!.rows.comments!.some((row) => row.body === "Refused API effect")).toBe(false);
    } finally {
      held.release();
    }
  },
);

it("local tracker reads and writes retain scoped receipts while the fleet kill switch blocks new effects", async () => {
  const f = await fixture({ local: true });
  const session = await f.initialize();
  const readId = randomUUID();
  const read = await f.call(
    { name: "linear_get_user", arguments: { query: "me" } },
    session,
    undefined,
    readId,
  );
  expect(read).toMatchObject({ outcome: "ok", receiptId: readId, isError: false, toolError: false });
  expect(JSON.stringify(JSON.parse(read.content)).toLowerCase()).toContain("local");
  expect(await f.call({ receiptId: readId }, session)).toEqual(read);
  const writeId = randomUUID();
  const write = { name: "linear_save_issue", arguments: { team: "LOCAL", title: "One local effect" } };
  const saved = await f.call(write, session, undefined, writeId);
  expect(saved).toMatchObject({ outcome: "ok", receiptId: writeId, isError: false, toolError: false });
  expect(await f.call(write, session, undefined, writeId)).toEqual(saved);
  expect(await f.call({ receiptId: writeId }, session)).toEqual(saved);
  expect(await f.localTracker!.call("list_issues", {})).toMatchObject({
    issues: [expect.objectContaining({ title: "One local effect" })],
  });
  await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
  expect(
    await f.call(
      { ...write, arguments: { team: "LOCAL", title: "Blocked local effect" } },
      session,
      undefined,
      randomUUID(),
    ),
  ).toMatchObject({
    outcome: "refused",
    toolError: true,
  });
  expect(await f.localTracker!.call("list_issues", {})).toMatchObject({
    issues: [expect.objectContaining({ title: "One local effect" })],
  });
});

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
  expect(await f.call({ receiptId: uncertain.receiptId }, session)).toMatchObject({
    outcome: "uncertain",
    receiptId: uncertain.receiptId,
    detail: uncertain.detail,
    reason: expect.stringMatching(/timed out|timeout/iu),
    toolError: false,
  });
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
