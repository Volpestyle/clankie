import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
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

it("gives a linked fleet's agents the tools granted to that fleet, until revoked (VUH-1527)", async () => {
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
  const open = async (token: string) => {
    const response = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bridge", version: "1" },
    });
    expect(response.status).toBe(200);
    return response.headers.get("mcp-session-id")!;
  };
  const tools = async (token: string, session: string) =>
    (
      (await (await rpc(token, "tools/list", {}, session)).json()) as {
        result: { tools: { name: string }[] };
      }
    ).result.tools.map((tool) => tool.name);

  // The owner's one step, with no tools named: the server's worker-safe set, and no bearer.
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
  expect(issued.status).toBe(201);
  const grant = (await issued.json()) as { token?: string; fleet: string; grant: { grantId: string } };
  expect(grant.token).toBeUndefined();
  expect(grant.fleet).toBe("kh2");

  const kh2 = await open("kh2-link");
  // Worker publishing must name a persona, so a fleet grant leaves it out.
  expect(await tools("kh2-link", kh2)).toEqual(["linear_get_issue", "linear_save_comment"]);
  const called = (await (
    await rpc("kh2-link", "tools/call", { name: "linear_save_comment", arguments: { issueId: "A-1" } }, kh2)
  ).json()) as { result: { content: { text: string }[]; isError: boolean } };
  expect(called.result).toMatchObject({ isError: false, content: [{ text: "ran save_comment" }] });
  expect(calls).toEqual([{ name: "save_comment", args: { issueId: "A-1" } }]);

  // Another fleet's link sees none of it, and nothing without a link gets in.
  expect(await tools("pc-link", await open("pc-link"))).toEqual([]);
  expect((await rpc("nope", "initialize", {})).status).toBe(401);
  // Another fleet's link cannot ride this fleet's session.
  expect((await rpc("pc-link", "tools/list", {}, kh2)).status).toBe(403);

  await worker.revoke(grant.grant.grantId);
  expect(await tools("kh2-link", kh2)).toEqual([]);
  await worker.close();
});
