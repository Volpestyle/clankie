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
  const worker = new WorkerMcp({ directory: join(root, "grants"), credentials, host });
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
  const issued = await worker.issue({
    principalId: "fleet:default",
    workId: "fleet:default",
    server: "linear",
    fleet: "default",
    tools: [{ name: "get_issue", arguments: { id: "A-1" } }],
  });
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
  expect(calls).toHaveLength(0);
  expect((await call({ id: "A-1" })).isError).toBe(false);
  expect(calls).toHaveLength(1);
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
  await worker.revoke(issued.grant.grantId);
  expect(await list()).toEqual([]);
  expect((await call({ id: "A-1" })).isError).toBe(true);
  live = false;
  expect((await rpc("w1:p1", "tools/list", {}, session)).status).toBe(403);
  live = true;
  await local.close();
  expect((await rpc("w1:p1", "tools/list", {}, session)).status).toBe(403);
  await worker.close();
});
