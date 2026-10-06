import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, it } from "vitest";
import {
  FileCredentialStore,
  LINEAR_API_PROVIDER_ID,
  type ProviderAccount,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { writeConvention } from "@clankie/work-items";
import { OPERATOR_CONVERSATION_DISPATCH_PATH } from "@clankie/protocol";
import { LinearRequestBudgetReportSchema } from "@clankie/protocol/linear-request-budget";
import { createLinearApiTracker } from "../src/linear-api-tracker.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { LinearRequestBudget, withLinearRequestPriority } from "../src/linear-request-budget.ts";
import {
  createLinearApiProvider,
  API_ACCESS,
  API_REFRESH,
  ISSUE_ID,
  PROJECT_ID,
  TEAM_ID,
  USER_ID,
} from "./fixtures/linear-api-provider.ts";
import { createConnectedLinearFixture } from "./fixtures/linear-connected-mcp.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { runLinearCommand } from "../../tui/src/command/linear.ts";
import { doctorCommand } from "../../tui/src/command/doctor.ts";
import { formatDoctorReport } from "../../tui/src/doctor-report.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const start = Date.parse("2026-10-05T12:00:00Z");
async function setup(
  previous: number,
  clock: () => number,
  budget: LinearRequestBudget,
  account?: ProviderAccount,
  providerOptions: { issueCount?: number; issuePageSize?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "linear-budget-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const provider = await createLinearApiProvider({
    ...providerOptions,
    requestBudget: { clock, limit: 5_000, previousRequests: Array.from({ length: previous }, () => clock()) },
  });
  cleanups.push(provider.close);
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  await credentials.set(LINEAR_API_PROVIDER_ID, {
    type: "oauth",
    access: API_ACCESS,
    refresh: API_REFRESH,
    expires: 0,
    linearAuth: "api",
    account: account ?? {
      provider: "linear",
      connectionId: randomUUID(),
      userId: USER_ID,
      workspaceId: "personal-workspace",
      actor: "app",
      name: "Clankie",
      workspaceName: "Personal",
      verifiedAt: new Date(start).toISOString(),
    },
  });
  const tracker = createLinearApiTracker({ credentials, fetch: provider.fetch, requestBudget: budget });
  const host = createMcpHost({
    credentials,
    settings: new SettingsStore(join(directory, "settings.json")),
    linearApiTracker: tracker,
    linearRequestBudget: budget,
    logger: { info: () => {}, warn: () => {} },
  });
  cleanups.push(() => host.close());
  return { provider, host, tracker, credentials, directory };
}

it("slows a once-per-second poller before the 5000/hour cap, warns once, and preserves priority writes", async () => {
  let now = start;
  const alerts: unknown[] = [];
  const budget = new LinearRequestBudget({ clock: () => now, onAlert: (account) => alerts.push(account) });
  // Other clients have spent 1000 requests: 1/sec by itself uses only 3600/hour.
  const { provider, host, tracker } = await setup(1_000, () => now, budget);
  let deferred = 0;
  for (let second = 1; second < 3_600; second++) {
    now = start + second * 1_000;
    const read = await host.call({
      lane: "operator",
      server: "linear",
      tool: "list_teams",
      arguments: {},
      requestPriority: "background",
    });
    if (read.outcome === "refused") {
      expect(read).toMatchObject({ reason: "linear_request_budget", possiblyDispatched: false });
      deferred++;
    } else expect(read.isError).toBe(false);
  }
  const before = LinearRequestBudgetReportSchema.parse(budget.report()).accounts[0]!;
  expect(before.status).toBe("throttled");
  expect(before.requests).toBeGreaterThanOrEqual(3_000);
  expect(before.requests).toBeLessThan(3_020);
  expect(before.backgroundMinIntervalMs).toBe(60_000);
  expect(deferred).toBeGreaterThan(500);
  expect(alerts).toHaveLength(1);
  expect(
    await host.call({ lane: "operator", server: "linear", tool: "get_issue", arguments: { id: ISSUE_ID } }),
  ).toMatchObject({ outcome: "ok", isError: false });
  expect(await tracker.call("get_issue", { id: ISSUE_ID })).toMatchObject({ id: ISSUE_ID });
  let dispatched = 0;
  const write = await host.call({
    lane: "operator",
    server: "linear",
    tool: "save_issue",
    arguments: { id: ISSUE_ID, title: "Priority write succeeded" },
    onDispatch: () => {
      dispatched++;
    },
  });
  expect(write).toMatchObject({ outcome: "ok", isError: false });
  expect(dispatched).toBe(1);
  expect(provider.issue.title).toBe("Priority write succeeded");
  expect(provider.rateLimited()).toBe(0);
  expect(budget.report().accounts[0]!.requests).toBe(
    provider.seen.filter((entry) => entry.path === "/graphql").length,
  );
  expect(provider.validationErrors).toEqual([]);
  now += 3_600_000;
  expect(budget.report().accounts[0]).toMatchObject({ requests: 0, utilization: 0, status: "normal" });
}, 60_000);

it("uses provider remaining/reset to refuse an unsent mutation before its receipt dispatch", async () => {
  let now = start;
  const budget = new LinearRequestBudget({ clock: () => now });
  const { provider, host } = await setup(4_998, () => now, budget);
  expect(
    await host.call({ lane: "operator", server: "linear", tool: "list_teams", arguments: {} }),
  ).toMatchObject({ outcome: "ok", isError: false });
  let dispatched = 0;
  expect(
    await host.call({
      lane: "operator",
      server: "linear",
      tool: "save_issue",
      arguments: { id: ISSUE_ID, title: "Must not dispatch" },
      onDispatch: () => {
        dispatched++;
      },
    }),
  ).toMatchObject({ outcome: "refused", reason: "linear_request_budget", possiblyDispatched: false });
  expect(dispatched).toBe(0);
  expect(provider.seen).toHaveLength(1);
  expect(provider.issue.title).toBe("Connect accounts");
  expect(budget.report().accounts[0]).toMatchObject({
    requests: 1,
    used: 4_999,
    requestsRemaining: 1,
    resetAt: start + 3_600_000,
    status: "limited",
  });
  now += 3_600_000;
  expect(
    await host.call({
      lane: "operator",
      server: "linear",
      tool: "save_issue",
      arguments: { id: ISSUE_ID, title: "After the reset" },
    }),
  ).toMatchObject({ outcome: "ok", isError: false });
  expect(provider.rateLimited()).toBe(0);
});

it("lets an admitted background read finish its provider pages while deferring the next read", async () => {
  let now = start;
  const budget = new LinearRequestBudget({ clock: () => now });
  const { provider, host } = await setup(3_999, () => now, budget);
  const read = await host.call({
    lane: "operator",
    server: "linear",
    tool: "get_project",
    requestPriority: "background",
    arguments: { query: PROJECT_ID, includeMilestones: true, includeResources: true, includeMembers: true },
  });
  expect(read).toMatchObject({ outcome: "ok", isError: false });
  const count = provider.seen.length;
  expect(count).toBeGreaterThan(1);
  expect(budget.report().accounts[0]!.requests).toBe(count);
  expect(
    await host.call({
      lane: "operator",
      server: "linear",
      tool: "list_teams",
      arguments: {},
      requestPriority: "background",
    }),
  ).toMatchObject({ outcome: "refused", reason: "linear_request_budget", retryAt: start + 60_000 });
  expect(provider.seen).toHaveLength(count);
  now += 60_000;
  expect(
    await host.call({
      lane: "operator",
      server: "linear",
      tool: "list_teams",
      arguments: {},
      requestPriority: "background",
    }),
  ).toMatchObject({ outcome: "ok", isError: false });
  expect(provider.validationErrors).toEqual([]);
});

it("counts real MCP initialization, catalog, and tool HTTP sends in the same actor bucket as API calls", async () => {
  const budget = new LinearRequestBudget({ clock: () => start });
  const fixture = await createConnectedLinearFixture({ requestBudget: budget });
  cleanups.push(fixture.close);
  const before = budget.report().accounts[0]!;
  expect(before.requests).toBe(fixture.providerWireRequests.length);
  expect(before.requests).toBeGreaterThan(2); // initialize, initialized, SSE/listTools
  const credential = await fixture.credentials.get("linear");
  if (credential?.type !== "api" || !credential.account) throw new Error("Missing fixture account");
  const { provider, host } = await setup(4_000, () => start, budget, credential.account);
  expect(
    await host.call({
      lane: "operator",
      server: "linear",
      tool: "list_teams",
      arguments: {},
      requestPriority: "background",
    }),
  ).toMatchObject({ outcome: "ok", isError: false });
  expect(budget.report().accounts).toHaveLength(1);
  expect(budget.report().accounts[0]!.requests).toBe(before.requests + 1);
  const calls = fixture.providerWireRequests.length;
  expect(
    await fixture.host.call({
      lane: "operator",
      server: "linear",
      tool: "list_issues",
      arguments: {},
      requestPriority: "background",
    }),
  ).toMatchObject({ outcome: "refused", reason: "linear_request_budget", possiblyDispatched: false });
  expect(fixture.providerWireRequests).toHaveLength(calls);
  expect(
    await runLinearCommand(["read", "list_issues", "--json-stdin", "--background"], {
      env: fixture.cliEnv,
      stdin: Readable.from(["{}"]),
    }),
  ).toMatchObject({ ok: false });
  expect(fixture.providerWireRequests).toHaveLength(calls);
  expect(
    await fixture.client.callTool({
      name: "linear_list_issues",
      arguments: {},
      _meta: { clankieRequestPriority: "background" },
    }),
  ).toMatchObject({
    content: [expect.objectContaining({ text: expect.stringContaining("linear_request_budget") })],
  });
  expect(fixture.providerWireRequests).toHaveLength(calls);
  expect(
    await runLinearCommand(["read", "list_issues", "--json-stdin"], {
      env: fixture.cliEnv,
      stdin: Readable.from(["{}"]),
    }),
  ).toMatchObject({ ok: true });
  expect(
    await fixture.host.call({
      lane: "operator",
      server: "linear",
      tool: "save_issue",
      arguments: { id: fixture.issueIdentifier, state: "Done" },
    }),
  ).toMatchObject({ outcome: "ok", isError: false });
  expect(budget.report().accounts[0]!.requests).toBe(
    fixture.providerWireRequests.length + provider.seen.length,
  );
});

it("gives each tool call a fresh polling admission inside one long-lived background scope", async () => {
  const budget = new LinearRequestBudget({ clock: () => start });
  const { provider, host, tracker } = await setup(3_999, () => start, budget);
  await withLinearRequestPriority("background", async () => {
    expect(
      await host.call({ lane: "operator", server: "linear", tool: "list_teams", arguments: {} }),
    ).toMatchObject({ outcome: "ok", isError: false });
    expect(
      await host.call({ lane: "operator", server: "linear", tool: "list_teams", arguments: {} }),
    ).toMatchObject({ outcome: "refused", reason: "linear_request_budget", possiblyDispatched: false });
    await expect(tracker.call("list_teams", {})).rejects.toMatchObject({ code: "linear_request_budget" });
  });
  expect(provider.seen).toHaveLength(1);
});

it("throttles the device Work refresh, preserves a cached backlog, and admits the owner CLI read", async () => {
  const budget = new LinearRequestBudget({ clock: () => start });
  const { provider, host, directory } = await setup(3_999, () => start, budget, undefined, {
    issueCount: 2,
    issuePageSize: 1,
  });
  const workspace = join(directory, "workspace");
  await writeConvention(workspace, {
    schemaVersion: 1,
    backend: "linear",
    linear: {
      team: TEAM_ID,
      project: PROJECT_ID,
    },
    decidedBy: "owner",
    decidedAt: new Date(start).toISOString(),
  });
  const workItems = createWorkItemsService({
    stateDirectory: join(directory, "work-state"),
    workspace: () => workspace,
    mcpHost: host,
  });
  const service = await createClankieApp({
    captain: createStubCaptain(),
    workItems,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
  });
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => service.app.fetch(request),
  }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing Work server");
  const post = async (path: string, body: unknown) =>
    (
      await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  const poll = () =>
    post(OPERATOR_CONVERSATION_DISPATCH_PATH, { op: "work_items", schemaVersion: 1, repoId: "workspace" });
  expect(await poll()).toMatchObject({
    result: {
      outcome: "ready",
      items: [expect.objectContaining({ id: "VUH-1383" }), expect.objectContaining({ id: "VUH-1384" })],
    },
  });
  const wires = provider.seen.length;
  expect(wires).toBeGreaterThanOrEqual(2);
  expect(await poll()).toMatchObject({ result: { outcome: "ready" } });
  expect(provider.seen).toHaveLength(wires);
  host.invalidateTrackerReads!(); // A provider update retires the old backlog snapshot.
  expect(await poll()).toMatchObject({
    result: {
      outcome: "unavailable",
      message: expect.stringContaining("Linear request budget background_throttled"),
    },
  });
  expect(provider.seen).toHaveLength(wires);
  expect(await post("/v1/work", { action: "list", repo: "workspace" })).toMatchObject({
    items: [expect.objectContaining({ id: "VUH-1383" }), expect.objectContaining({ id: "VUH-1384" })],
  });
  expect(provider.seen.length).toBeGreaterThan(wires);
  expect(budget.report().accounts[0]!.requests).toBe(provider.seen.length);
  expect(provider.validationErrors).toEqual([]);
});

it("admits all native MCP Work pages as one device refresh and defers the following refresh", async () => {
  const budget = new LinearRequestBudget({ clock: () => start });
  const fixture = await createConnectedLinearFixture({
    requestBudget: budget,
    nativePagesOnly: true,
    priorityPages: [
      [{ id: "VUH-PAGE-1", title: "First page", status: "Done", description: "" }],
      [{ id: "VUH-PAGE-2", title: "Second page", status: "Done", description: "" }],
    ],
  });
  cleanups.push(fixture.close);
  const credential = await fixture.credentials.get("linear");
  if (credential?.type !== "api" || !credential.account) throw new Error("Missing MCP account");
  const { host: apiHost, directory } = await setup(3_999, () => start, budget, credential.account);
  expect(
    await apiHost.call({ lane: "operator", server: "linear", tool: "list_teams", arguments: {} }),
  ).toMatchObject({ outcome: "ok", isError: false });
  const workspace = join(directory, "workspace");
  await writeConvention(workspace, {
    schemaVersion: 1,
    backend: "linear",
    linear: { team: "VUH" },
    decidedBy: "owner",
    decidedAt: new Date(start).toISOString(),
  });
  const workItems = createWorkItemsService({
    stateDirectory: join(directory, "work-state"),
    workspace: () => workspace,
    mcpHost: fixture.host,
  });
  const service = await createClankieApp({
    captain: createStubCaptain(),
    workItems,
    authenticateOperator: async () => ({ operatorId: "owner" }),
    authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
  });
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => service.app.fetch(request),
  }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing native Work server");
  const poll = async () =>
    (
      await fetch(`http://127.0.0.1:${address.port}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "work_items", schemaVersion: 1, repoId: "workspace" }),
      })
    ).json();
  expect(await poll()).toMatchObject({
    result: {
      outcome: "ready",
      items: [expect.objectContaining({ id: "VUH-PAGE-1" }), expect.objectContaining({ id: "VUH-PAGE-2" })],
    },
  });
  expect(fixture.providerReads()).toHaveLength(2);
  expect(fixture.providerReads()[1]).toMatchObject({ cursor: "1" });
  const wires = fixture.providerWireRequests.length;
  expect(await poll()).toMatchObject({
    result: { outcome: "unavailable", message: expect.stringContaining("background_throttled") },
  });
  expect(fixture.providerWireRequests).toHaveLength(wires);
});

it("carries native fleet background:true through the real two-tool MCP bridge while prioritizing reads and writes", async () => {
  const budget = new LinearRequestBudget({ clock: () => start });
  const { provider, host, credentials, directory } = await setup(3_999, () => start, budget);
  expect(
    await host.call({ lane: "operator", server: "linear", tool: "list_teams", arguments: {} }),
  ).toMatchObject({ outcome: "ok", isError: false });
  const settings = new SettingsStore(join(directory, "worker-settings.json"));
  await settings.update((value) => ({ ...value, fleet: { ...value.fleet, tools: "connected" } }));
  const worker = new WorkerMcp({
    directory: join(directory, "worker"),
    credentials,
    host,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const snapshot = await settings.loadFenced();
      return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
    },
  });
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => worker.handleFleet("budget-fleet", request, (token) => token === "budget-worker"),
  }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(async () => {
    await worker.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing worker server");
  const client = new Client({ name: "native-worker-budget", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { authorization: "Bearer budget-worker" } },
    }) as unknown as Transport,
  );
  cleanups.push(() => client.close());
  expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("clankie_call");
  const call = (
    background?: boolean,
    name = "linear_get_issue",
    args: Record<string, unknown> = { id: ISSUE_ID },
  ) =>
    client.callTool({
      name: "clankie_call",
      arguments: { name, arguments: args, ...(background ? { background } : {}) },
    });
  const first = await call(true);
  expect(first.isError, JSON.stringify(first)).toBe(false);
  const wires = provider.seen.length;
  expect(await call(true)).toMatchObject({
    content: [
      expect.objectContaining({
        text: expect.stringContaining("linear_request_budget"),
      }),
    ],
  });
  expect(provider.seen).toHaveLength(wires);
  expect(await call()).toMatchObject({ isError: false });
  expect(provider.seen).toHaveLength(wires + 1);
  expect(
    await call(true, "linear_save_issue", { id: ISSUE_ID, title: "Native priority write" }),
  ).toMatchObject({ isError: false });
  expect(provider.issue.title).toBe("Native priority write");
  expect(provider.rateLimited()).toBe(0);
});

it("counts the GraphQL identity request made when a connected app credential refreshes", async () => {
  const budget = new LinearRequestBudget({ clock: () => start });
  const { provider, credentials, directory } = await setup(0, () => start, budget);
  const connected = await credentials.get(LINEAR_API_PROVIDER_ID);
  if (connected?.type !== "oauth") throw new Error("Missing app identity");
  await credentials.set("linear", {
    ...connected,
    linearAuth: "app",
    expires: 1,
    clientId: "fixture-app",
    clientSecret: "fixture-app-secret",
  });
  const host = createMcpHost({
    credentials,
    settings: new SettingsStore(join(directory, "refresh-settings.json")),
    curated: [
      {
        id: "linear",
        transport: "http",
        url: `${provider.origin}/mcp`,
        credential: "linear",
        enabled: true,
        lane: "everywhere",
        args: [],
        initialTools: [],
      },
    ],
    linearFetch: provider.fetch,
    linearRequestBudget: budget,
    logger: { info: () => {}, warn: () => {} },
  });
  cleanups.push(() => host.close());
  // This local provider offers GraphQL/OAuth, not MCP; its MCP 404 attempts are also counted.
  await host.warm();
  const graphql = provider.seen.filter((entry) => entry.path === "/graphql");
  expect(graphql).toHaveLength(1);
  expect(graphql[0]!.query).toContain("viewer");
  expect(provider.seen.filter((entry) => entry.path === "/oauth/token")).toHaveLength(1);
  expect(budget.report().accounts[0]!.requests).toBe(
    provider.seen.filter((entry) => entry.path !== "/oauth/token").length,
  );
  expect(await credentials.get("linear")).toMatchObject({
    account: { connectionId: connected.account!.connectionId },
    expires: expect.any(Number),
  });
  expect(provider.validationErrors).toEqual([]);
});

it("excludes the registered API OAuth token refresh and counts its subsequent provider read", async () => {
  const budget = new LinearRequestBudget({ clock: () => start });
  const { provider, tracker, credentials } = await setup(0, () => start, budget);
  const credential = await credentials.get(LINEAR_API_PROVIDER_ID);
  if (credential?.type !== "oauth") throw new Error("Missing app identity");
  await credentials.set(LINEAR_API_PROVIDER_ID, {
    ...credential,
    expires: 1,
    clientId: "fixture-app",
    clientSecret: "fixture-app-secret",
  });
  expect(await tracker.call("get_issue", { id: ISSUE_ID })).toMatchObject({ id: ISSUE_ID });
  expect(provider.seen.filter((entry) => entry.path === "/oauth/token")).toHaveLength(1);
  expect(provider.seen.filter((entry) => entry.path === "/graphql")).toHaveLength(1);
  expect(budget.report().accounts[0]!.requests).toBe(1);
  expect(provider.validationErrors).toEqual([]);
});

it("does not restore headroom when an older HTTP response arrives after a newer reset observation", async () => {
  let now = start;
  const budget = new LinearRequestBudget({ clock: () => now });
  const { provider, host } = await setup(4_899, () => now, budget);
  const held = provider.blockNextGraphql();
  const first = host.call({ lane: "operator", server: "linear", tool: "list_teams", arguments: {} });
  await held.started;
  now += 1_000;
  provider.spendRequests(98);
  expect(
    await host.call({ lane: "operator", server: "linear", tool: "list_teams", arguments: {} }),
  ).toMatchObject({ outcome: "ok", isError: false });
  expect(budget.report().accounts[0]).toMatchObject({ requestsRemaining: 1, resetAt: now + 3_600_000 });
  held.release();
  expect(await first).toMatchObject({ outcome: "ok", isError: false });
  expect(budget.report().accounts[0]).toMatchObject({ requestsRemaining: 1, resetAt: now + 3_600_000 });
  expect(
    await host.call({
      lane: "operator",
      server: "linear",
      tool: "save_issue",
      arguments: { id: ISSUE_ID, title: "No restored headroom" },
    }),
  ).toMatchObject({ outcome: "refused", reason: "linear_request_budget", possiblyDispatched: false });
  expect(provider.seen).toHaveLength(2);
  expect(provider.rateLimited()).toBe(0);
});

it("projects the warning through authenticated HTTP, CLI, and doctor without spending provider requests", async () => {
  const alerts: unknown[] = [];
  const budget = new LinearRequestBudget({ clock: () => start, onAlert: (account) => alerts.push(account) });
  const { provider, host } = await setup(2_499, () => start, budget);
  expect(
    await host.call({ lane: "operator", server: "linear", tool: "list_teams", arguments: {} }),
  ).toMatchObject({ outcome: "ok", isError: false });
  expect(alerts).toHaveLength(1);
  const service = await createClankieApp({
    captain: createStubCaptain(),
    linearRequestBudget: budget,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer budget-owner"
        ? { operatorId: "budget-owner" }
        : undefined,
  });
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => service.app.fetch(request),
  }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing budget server");
  const origin = `http://127.0.0.1:${address.port}`;
  expect((await fetch(`${origin}/v1/linear/request-budget`)).status).toBe(401);
  const directory = await mkdtemp(join(tmpdir(), "budget-doctor-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const env = {
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "config"),
    PATH: "",
    CLANKIE_STATE: join(directory, "state"),
    CLANKIE_OPERATOR_TOKEN: "budget-owner",
    CLANKIE_CONTROL_PLANE_URL: origin,
  };
  const cli = await runLinearCommand(["budget"], { env });
  expect(cli).toEqual(budget.report());
  const doctor = await doctorCommand({
    repoRoot: directory,
    env,
    credentialStore: new FileCredentialStore(join(directory, "credentials.json")),
  });
  expect(doctor.linearRequestBudget).toEqual(cli);
  expect(formatDoctorReport(doctor)).toContain("50% of 5000 · warning");
  expect(provider.seen).toHaveLength(1);
  expect(alerts).toHaveLength(1);
  const serialized = JSON.stringify(cli);
  expect(serialized).not.toContain(API_ACCESS);
  expect(serialized).not.toContain(API_REFRESH);
});
