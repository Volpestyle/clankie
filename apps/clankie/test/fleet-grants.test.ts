import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileCredentialStore, type ProviderAccount } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { fleetLinkFetch } from "../src/fleet-link.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

it("retires fleet grants without copying or mutating them and admits bearer fleets without claiming a pane", async () => {
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
  const links = { authenticate: (token: string) => ({ "kh2-link": "kh2", "pc-link": "pc" })[token] };
  const clankie = await createClankieApp({
    captain: createStubCaptain(),
    workerMcp: worker,
    fleetLinks: links,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  // Through the link listener, as a linked machine reaches it.
  const fetch = fleetLinkFetch(clankie.app.fetch);
  const rpc = async (token: string, method: string, params: unknown, session?: string) =>
    fetch(
      new Request("http://127.0.0.1/v1/fleet/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(session === undefined ? {} : { "mcp-session-id": session }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
  const grant = await worker.issue({
    principalId: "fleet:kh2",
    workId: "fleet:kh2",
    server: "linear",
    tools: [{ name: "get_issue" }],
  });
  const path = join(root, "grants", `${grant.grant.grantId}.json`);
  const saved = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...saved, fleet: "kh2" }));
  const original = await readFile(path, "utf8");
  const issued = await clankie.app.request("/v1/worker-grants/", {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({
      principalId: "fleet:kh2",
      workId: "fleet:kh2",
      server: "linear",
      fleet: "kh2",
      tools: [],
    }),
  });
  expect(issued.status).toBe(400);
  let firstSession: string | undefined;
  for (const token of ["kh2-link", "pc-link"]) {
    const init = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    const session = init.headers.get("mcp-session-id")!;
    firstSession ??= session;
    const listedTools = (await (await rpc(token, "tools/list", {}, session)).json()).result.tools;
    expect(listedTools.map((tool: { name: string }) => tool.name)).toEqual(["clankie_tools", "clankie_call"]);
    const called = await (
      await rpc(
        token,
        "tools/call",
        { name: "clankie_call", arguments: { name: "linear_get_issue", arguments: { id: "A-1" } } },
        session,
      )
    ).json();
    expect(called.result.isError).toBe(false);
  }
  expect((await rpc("pc-link", "tools/list", {}, firstSession)).status).toBe(403);
  expect((await rpc("nope", "initialize", {})).status).toBe(401);
  expect(
    (
      await worker.handle(
        new Request("http://local/v1/worker-mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${grant.token}` },
        }),
      )
    ).status,
  ).toBe(403);
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await worker.list()).toMatchObject([{ fleet: "kh2" }]);
  const listed = await clankie.app.request("/v1/worker-grants/", {
    headers: { authorization: "Bearer owner" },
  });
  expect(await listed.json()).toMatchObject([
    { fleet: "kh2", status: "retired", detail: expect.stringContaining("fleet status") },
  ]);
  expect(calls).toHaveLength(2);
  await worker.revoke(grant.grant.grantId);
  expect((await worker.list())[0]!.revokedAt).toBeDefined();
  await worker.close();
  await host.close();
  clankie.close();
});
