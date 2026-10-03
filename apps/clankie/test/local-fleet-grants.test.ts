import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FileCredentialStore, type ProviderAccount } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

import type { HttpBindings } from "@hono/node-server";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
it("binds local MCP sessions and mailbox routes to proven panes and rechecks scope and revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-fleet-grants-"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const account: ProviderAccount = {
    provider: "linear",
    connectionId: randomUUID(),
    userId: "bot-user",
    workspaceId: "workspace",
    email: "bot@example.com",
    name: "Bot",
    workspaceName: "Team",
    verifiedAt: new Date().toISOString(),
  };
  await credentials.set("linear", { type: "api", key: "provider-secret", account });
  const calls: { name: string; args: unknown }[] = [];
  const host = createMcpHost({
    credentials,
    settings: { load: async () => ({ mcp: { servers: [] } }) } as unknown as SettingsStore,
    curated: [
      {
        id: "linear",
        credential: "linear",
        transport: "http",
        url: "https://example.test/mcp",
        lane: "operator",
        enabled: true,
        args: [],
        initialTools: [],
      },
    ],
    logger: { info: () => undefined, warn: () => undefined },
    connect: async () => ({
      listTools: async () =>
        ["get_issue", "save_comment", "create_worker_comment"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { content: `ran ${name}`, isError: false };
      },
      close: async () => undefined,
    }),
  });
  let project = "kh2";
  let occupant = "first";
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    projects: async () => ProjectsSettingsSchema.parse({ projects: [{ id: "kh2", name: "KH2" }] }),
    membership: async (identity) => ({ projectId: project, occupantId: `${identity.pane}:${occupant}` }),
  });
  let live = true;
  let checks = 0;
  let failAfter = Infinity;
  const local = new LocalFleetLink({
    directory: join(root, "links"),
    binding: async () => ({ runtime: "external", session: "default", socketPath: "/test/herdr.sock" }),
    prove: async (_socket, pane) => live && ++checks <= failAfter && ["w1:p1", "w1:p2"].includes(pane),
  });
  let mailboxPane: string | undefined;
  const clankie = await createClankieApp({
    captain: {
      ...createStubCaptain(),
      pollFleetSeatEvents: async (pane) => {
        mailboxPane = pane;
        return [];
      },
    },
    workerMcp: worker,
    localFleet: local,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const linked = local.fetch(clankie.app.fetch);
  const request = (pane: string, method: string, params: unknown, session?: string) =>
    new Request("http://127.0.0.1/v1/fleet/mcp", {
      method: "POST",
      headers: {
        "x-clankie-pane": pane,
        authorization: "Bearer owner",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const rpc = (pane: string, method: string, params: unknown, session?: string) =>
    linked(request(pane, method, params, session), { incoming: { socket: {} } } as HttpBindings);
  const grantRequest = {
    principalId: "project:kh2",
    workId: "project:kh2",
    server: "linear",
    project: "kh2",
    tools: [{ name: "get_issue", arguments: { id: "A-1" }, forbiddenArguments: ["alternateId"] }],
  };
  await expect(worker.issue({ ...grantRequest, project: "missing" })).rejects.toThrow("Create this project");
  await expect(worker.issue({ ...grantRequest, principalId: "project:rivals" })).rejects.toThrow(
    "must name their project",
  );
  const issueResponse = await clankie.app.request("/v1/worker-grants/", {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify(grantRequest),
  });
  expect(issueResponse.status).toBe(201);
  const issued = await issueResponse.json();
  expect(issued.token).toBeUndefined();
  expect(issued.project).toBe("kh2");
  expect(await worker.expectedProjectToolNames("kh2")).toEqual(["linear_get_issue"]);
  expect(await worker.expectedProjectToolNames("ungranted")).toEqual([]);
  const unavailableCatalog = vi.spyOn(host, "catalog").mockResolvedValueOnce([]);
  await expect(worker.expectedProjectToolNames("kh2")).rejects.toThrow("project-granted tool is unavailable");
  unavailableCatalog.mockRestore();
  const initialized = await rpc("w1:p1", "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  expect(initialized.status).toBe(200);
  let session = initialized.headers.get("mcp-session-id")!;
  const list = async () => (await (await rpc("w1:p1", "tools/list", {}, session)).json()).result.tools;
  expect(await list()).toMatchObject([{ name: "linear_get_issue" }]);
  expect((await rpc("w1:p2", "tools/list", {}, session)).status).toBe(403);
  // Even an operator header cannot manufacture the listener's private request identity.
  expect((await clankie.app.fetch(request("w1:p1", "tools/list", {}, session))).status).toBe(401);
  const call = async (args: unknown) =>
    (await (await rpc("w1:p1", "tools/call", { name: "linear_get_issue", arguments: args }, session)).json())
      .result;
  expect((await call({ id: "OTHER" })).isError).toBe(true);
  expect((await call({ id: "A-1", alternateId: null })).isError).toBe(true);
  expect(calls).toHaveLength(0);
  expect((await call({ id: "A-1" })).isError).toBe(false);
  expect(calls).toHaveLength(1);
  project = "rivals";
  expect((await rpc("w1:p1", "tools/list", {}, session)).status).toBe(403);
  project = "kh2";
  occupant = "replacement";
  expect((await rpc("w1:p1", "tools/list", {}, session)).status).toBe(403);
  occupant = "first";
  await credentials.set("linear", {
    type: "api",
    key: "rotated",
    account: { ...account, connectionId: randomUUID() },
  });
  expect(await list()).toEqual([]);
  await expect(worker.expectedProjectToolNames("kh2")).rejects.toThrow("account changed");
  expect((await call({ id: "A-1" })).isError).toBe(true);
  await credentials.set("linear", { type: "api", key: "provider-secret", account });
  // Membership can disappear after listener admission but before the SDK invokes the tool.
  checks = 0;
  failAfter = 2;
  expect((await call({ id: "A-1" })).isError).toBe(true);
  expect(calls).toHaveLength(1);
  failAfter = Infinity;
  const seat = (pane: string, path: string) =>
    linked(
      new Request(`http://127.0.0.1/v1/fleet/seats/${path}/events`, { headers: { "x-clankie-pane": pane } }),
      { incoming: { socket: {} } } as HttpBindings,
    );
  expect((await seat("w1:p1", "w1:p1")).status).toBe(200);
  expect(mailboxPane).toBe("w1:p1");
  expect((await seat("w1:p1", "w1:p2")).status).toBe(403);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 901_000);
  expect((await rpc("w1:p1", "tools/list", {}, session)).status).toBe(404);
  clock.mockRestore();
  const reopened = await rpc("w1:p1", "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  session = reopened.headers.get("mcp-session-id")!;
  expect(await worker.expectedProjectToolNames("kh2")).toContain("linear_get_issue");
  const originalAccount = host.account.bind(host);
  let bindingChecks = 0;
  const bindingSpy = vi.spyOn(host, "account").mockImplementation(async (...args) => {
    const result = await originalAccount(...args);
    // Revoke after the handler has loaded its grant snapshot, before dispatch.
    if (++bindingChecks === 2) await worker.revoke(issued.grant.grantId);
    return result;
  });
  expect((await call({ id: "A-1" })).isError).toBe(true);
  expect(calls).toHaveLength(1);
  bindingSpy.mockRestore();
  expect(await worker.expectedProjectToolNames("kh2")).toEqual([]);
  expect(await list()).toEqual([]);
  expect((await call({ id: "A-1" })).isError).toBe(true);
  live = false;
  expect((await rpc("w1:p1", "tools/list", {}, session)).status).toBe(403);
  live = true;
  await local.close();
  expect((await rpc("w1:p1", "tools/list", {}, session)).status).toBe(403);
  await worker.close();
});
it("admits exact linked receipt and ACK routes only with the same proven local pane and live membership", async () => {
  let live = true;
  let checks = 0;
  let failAfter = Infinity;
  const local = new LocalFleetLink({
    directory: "/unused",
    binding: async () => undefined,
    prove: async (_socket, pane) => live && ++checks <= failAfter && pane === "w1:p1",
  });
  const deliveryId = randomUUID();
  const binding = "a".repeat(64);
  const fingerprint = "b".repeat(64);
  const reconciled: string[] = [];
  const acknowledged: string[] = [];
  const app = await createClankieApp({
    localFleet: local,
    authenticateOperator: async () => undefined,
    captain: createStubCaptain({
      fleetSeatMessageBinding: async () => binding,
      reconcileFleetSeatMessage: async (pane, delivery) => {
        reconciled.push(`${pane}/${delivery.id}`);
        return {
          schemaVersion: 1,
          received: true,
          deliveryStage: "stored",
          deliveryId: delivery.id,
          binding,
          fingerprint,
        };
      },
      acknowledgeFleetSeatEvent: async (pane, id) => {
        acknowledged.push(`${pane}/${id}`);
        return true;
      },
    }),
  });
  const forward = local.fetch(app.app.fetch);
  const messagePath = `/v1/fleet/seats/w1%3Ap1/messages/${deliveryId}?binding=${binding}&fingerprint=${fingerprint}`;
  const ackPath = "/v1/fleet/seats/w1%3Ap1/events/seat-original/ack";
  const request = (path: string, method = "GET", pane = "w1:p1") =>
    new Request(`http://127.0.0.1${path}`, { method, headers: { "x-clankie-pane": pane } });
  const linked = (path: string, method = "GET", pane = "w1:p1") =>
    forward(request(path, method, pane), { incoming: { socket: {} } } as HttpBindings);
  try {
    expect((await app.app.fetch(request(messagePath))).status).toBe(401);
    expect((await linked(messagePath)).status).toBe(200);
    expect((await linked(ackPath, "POST")).status).toBe(200);
    expect(reconciled).toEqual([`w1:p1/${deliveryId}`]);
    expect(acknowledged).toEqual(["w1:p1/seat-original"]);
    expect((await linked(messagePath, "GET", "w1:p2")).status).toBe(403);
    expect((await linked(messagePath, "POST")).status).toBe(404);
    expect((await linked(ackPath)).status).toBe(404);
    expect((await linked("/v1/fleet/seats/w1%3Ap1/messages/not-a-uuid")).status).toBe(404);
    expect((await linked("/v1/captain/seat-events/original/ack", "POST")).status).toBe(404);
    checks = 0;
    failAfter = 1;
    expect((await linked(messagePath)).status).toBe(403);
    expect(reconciled).toHaveLength(1);
    failAfter = Infinity;
    live = false;
    expect((await linked(ackPath, "POST")).status).toBe(403);
    expect(acknowledged).toHaveLength(1);
  } finally {
    app.close();
    await local.close();
  }
});
