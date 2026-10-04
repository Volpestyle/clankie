import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileCredentialStore, type ProviderAccount } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("delegates one verified account to isolated workers, with durable revocation and no operator access", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-grants-"));
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
  const calls: unknown[] = [];
  const observed: unknown[] = [];
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
      listTools: async () => ["comment", "delete"].map((name) => ({ name, inputSchema: { type: "object" } })),
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { content: "published", isError: false };
      },
      close: async () => undefined,
    }),
    observeCall: (call) => {
      observed.push(call);
    },
  });
  const options = {
    directory: join(root, "grants"),
    credentials,
    host,
    // The fleet kill switch must not weaken or revoke manual grant behavior.
    fleetTools: async () => "off" as const,
  };
  let worker = new WorkerMcp(options);
  const app = await createClankieApp({
    captain: createStubCaptain(),
    get workerMcp() {
      return worker;
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const headers = (token: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  const request = (principalId: string) => ({
    principalId,
    workId: "issue-1",
    server: "linear",
    tools: [{ name: "comment", arguments: { issueId: "issue-1" }, forbiddenArguments: ["id"] }],
    ttlSeconds: 900,
  });
  async function rpc(token: string, method: string, params: unknown = {}, session?: string) {
    return app.app.request("/v1/worker-mcp", {
      method: "POST",
      headers: { ...headers(token), ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  }
  async function initialize(token: string) {
    const response = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "worker", version: "1" },
    });
    expect(response.status).toBe(200);
    return response.headers.get("mcp-session-id")!;
  }
  try {
    for (const path of ["/v1/worker-grants", "/v1/worker-grants/", "/v1/worker-grants/linear/account"]) {
      for (const method of ["GET", "POST", "DELETE"])
        expect((await app.app.request(path, { method })).status).toBe(401);
    }
    await credentials.set("linear", { type: "api", key: "provider-secret" });
    await expect(worker.issue(request("first"))).rejects.toThrow(/verified/iu);
    await credentials.set("linear", { type: "oauth", access: "mcp-only", refresh: "refresh", expires: 0 });
    expect(await worker.linearAccount()).toEqual({ status: "unverified", type: "oauth" });
    await expect(worker.issue(request("first"))).rejects.toThrow(/verified/iu);
    await credentials.set("linear", { type: "api", key: "provider-secret", account });
    const response = await app.app.request("/v1/worker-grants/", {
      method: "POST",
      headers: headers("owner"),
      body: JSON.stringify(request("first")),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = (await response.json()) as Awaited<ReturnType<WorkerMcp["issue"]>>;
    const second = await worker.issue(request("second"));
    const retired = await worker.issue(request("retired"));
    const retiredPath = join(options.directory, `${retired.grant.grantId}.json`);
    const stored = JSON.parse(await readFile(retiredPath, "utf8"));
    for (const binding of [{ swarm: { taskId: "old-task" } }, { renewable: true }]) {
      await writeFile(retiredPath, JSON.stringify({ ...stored, ...binding }));
      expect((await rpc(retired.token, "initialize")).status).toBe(403);
      expect((await worker.list()).some((record) => record.grant.grantId === retired.grant.grantId)).toBe(
        false,
      );
    }
    expect(JSON.parse(await readFile(retiredPath, "utf8")).renewable).toBe(true);
    expect(JSON.stringify(first)).not.toContain("provider-secret");
    expect(JSON.stringify(await worker.list())).not.toContain(first.token);
    for (const method of ["GET", "POST", "DELETE"])
      expect(
        (await app.app.request("/v1/worker-grants/", { method, headers: headers(first.token) })).status,
      ).toBe(401);
    expect((await app.app.request("/v1/runtime-connections", { headers: headers(first.token) })).status).toBe(
      401,
    );
    const session = await initialize(first.token);
    const other = await initialize(second.token);
    const listed = await (await rpc(first.token, "tools/list", {}, session)).json();
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["linear_comment"]);
    expect((await rpc(second.token, "tools/list", {}, session)).status).toBe(403);
    for (const [name, issueId] of [
      ["linear_delete", "issue-1"],
      ["linear_comment", "another-issue"],
    ]) {
      const refused = await (
        await rpc(first.token, "tools/call", { name, arguments: { issueId } }, session)
      ).json();
      expect(refused.result.isError).toBe(true);
    }
    for (const id of ["another-issues-comment", null, ""]) {
      const refused = await (
        await rpc(
          first.token,
          "tools/call",
          {
            name: "linear_comment",
            arguments: { issueId: "issue-1", id, body: "overwrite" },
          },
          session,
        )
      ).json();
      expect(refused.result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
    for (const [token, sid] of [
      [first.token, session],
      [second.token, other],
    ]) {
      const result = await (
        await rpc(
          token!,
          "tools/call",
          { name: "linear_comment", arguments: { issueId: "issue-1", body: "done" } },
          sid,
        )
      ).json();
      expect(result.result.isError).toBe(false);
    }
    expect(calls).toHaveLength(2);
    expect(observed).toMatchObject([
      { worker: { principalId: "first", workId: "issue-1", grantId: first.grant.grantId } },
      { worker: { principalId: "second", workId: "issue-1", grantId: second.grant.grantId } },
    ]);
    await worker.revoke(first.grant.grantId);
    expect((await rpc(first.token, "tools/list", {}, session)).status).toBe(403);
    expect((await rpc(second.token, "tools/list", {}, other)).status).toBe(200);
    await worker.close();
    worker = new WorkerMcp(options);
    expect((await rpc(first.token, "initialize")).status).toBe(403);
    const restored = await initialize(second.token);
    const refusedEdit = await (
      await rpc(
        second.token,
        "tools/call",
        {
          name: "linear_comment",
          arguments: { issueId: "issue-1", id: "unrelated-comment", body: "overwrite" },
        },
        restored,
      )
    ).json();
    expect(refusedEdit.result.isError).toBe(true);
    expect(calls).toHaveLength(2);
    await credentials.set("linear", {
      type: "api",
      key: "replacement",
      account: { ...account, connectionId: randomUUID() },
    });
    expect((await rpc(second.token, "tools/list", {}, restored)).status).toBe(403);
    await credentials.delete("linear");
    expect((await rpc(second.token, "tools/list", {}, restored)).status).toBe(403);
    await credentials.set("linear", { type: "api", key: "provider-secret", account });
    vi.spyOn(Date, "now").mockReturnValue((second.grant.expiresAt + 1) * 1000);
    expect((await rpc(second.token, "tools/list", {}, restored)).status).toBe(403);
    expect(calls).toHaveLength(2);
  } finally {
    app.close();
    await worker.close();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("verifies OAuth at Linear's MCP audience, preserves grant identity and serializes disconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-linear-identity-"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const host = createMcpHost({
    credentials,
    settings: { load: async () => ({ mcp: { servers: [] } }) } as unknown as SettingsStore,
    logger: { info() {}, warn() {} },
  });
  const worker = new WorkerMcp({ directory: join(root, "grants"), credentials, host });
  let userId = randomUUID();
  const workspaceId = randomUUID();
  let failure: "tool" | "malformed" | undefined;
  let pause: (() => Promise<void>) | undefined;
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://mcp.linear.app/token") {
      return Response.json({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 });
    }
    expect(String(url)).toBe("https://mcp.linear.app/mcp");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh");
    const body = JSON.parse(String(init?.body));
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize")
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "linear", version: "1" },
        },
      });
    expect(body.method).toBe("tools/call");
    calls.push(body.params.name);
    if (body.params.name === "get_user") expect(body.params.arguments).toEqual({ query: "me" });
    else {
      expect(body.params.name).toBe("get_workspace");
      expect(body.params.arguments).toEqual({});
    }
    await pause?.();
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        isError: failure === "tool",
        content: [
          {
            type: "text",
            text:
              failure === "malformed"
                ? '{"name":"missing stable ID"}'
                : JSON.stringify(
                    body.params.name === "get_user"
                      ? { id: userId, email: "bot@example.com", name: "Bot" }
                      : { id: workspaceId, name: "Workspace" },
                  ),
          },
        ],
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    await credentials.set("linear", {
      type: "oauth",
      access: "expired",
      refresh: "old",
      expires: 1,
      clientId: "client",
    });
    failure = "tool";
    await expect(worker.linearAccount(true)).rejects.toThrow(/identity verification/u);
    expect(await credentials.get("linear")).toMatchObject({ access: "fresh", refresh: "rotated" });
    expect(await worker.linearAccount()).toEqual({ status: "unverified", type: "oauth" });
    failure = "malformed";
    await expect(worker.linearAccount(true)).rejects.toThrow();
    failure = undefined;
    const verified = await worker.linearAccount(true);
    expect(verified).toMatchObject({
      status: "verified",
      account: { userId, workspaceId, email: "bot@example.com" },
    });
    expect(calls.slice(-2)).toEqual(["get_user", "get_workspace"]);
    const binding = (await host.account("linear", "operator")).binding;
    expect((await worker.linearAccount(true)).account?.connectionId).toBe(verified.account?.connectionId);
    expect((await host.account("linear", "operator")).binding).toBe(binding);
    userId = randomUUID();
    expect((await worker.linearAccount(true)).account?.connectionId).not.toBe(verified.account?.connectionId);
    expect((await host.account("linear", "operator")).binding).not.toBe(binding);

    let release!: () => void;
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    pause = async () => {
      entered();
      await held;
    };
    const verifying = worker.linearAccount(true);
    await admitted;
    const disconnecting = credentials.delete("linear");
    release();
    await Promise.all([verifying, disconnecting]);
    expect(await worker.linearAccount()).toEqual({ status: "disconnected" });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
