import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { FileCredentialStore, type ProviderAccount } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost, type McpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renews only live opted-in assignments without broadening authority or escaping revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-renew-"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const account: ProviderAccount = {
    provider: "linear",
    connectionId: randomUUID(),
    userId: "bot",
    workspaceId: "team",
    email: "bot@example.com",
    name: "Bot",
    workspaceName: "Team",
    verifiedAt: new Date().toISOString(),
  };
  let active = true,
    binding = "account-1";
  const host: McpHost = {
    account: async () => ({ account, binding }),
    catalog: async () => [
      {
        server: "linear",
        name: "comment",
        qualifiedName: "linear_comment",
        description: "Comment",
        inputSchema: { type: "object" },
        initial: true,
      },
    ],
    call: async () => ({ outcome: "ok", content: "published", isError: false }),
    warm: async () => undefined,
    close: async () => undefined,
  };
  const options = {
    directory: join(root, "grants"),
    credentials,
    host,
    swarm: {
      workerInScope: async (scope: string, capability: string) => {
        if (scope !== "scope" || !["worker-session", "other-worker"].includes(capability))
          throw new Error("Invalid session");
        return { actor: capability === "worker-session" ? "worker" : "other", scope };
      },
      worker: async (_conversationId: string, capability: string) => {
        if (capability === "worker-session") return { actor: "worker", scope: "scope" };
        if (capability === "other-worker") return { actor: "other", scope: "scope" };
        if (capability === "other-scope") return { actor: "worker", scope: "other" };
        throw new Error("Invalid session capability");
      },
      assignment: async (conversationId: string, taskId: string, actor: string, connectionId?: string) => {
        if (!active) throw new Error("Work ended");
        return {
          conversationId,
          taskId,
          actor,
          ...(connectionId ? { connectionId } : {}),
          scope: "scope",
          attemptId: "attempt",
          fence: 1,
        };
      },
    },
  };
  let worker = new WorkerMcp(options);
  const app = await createClankieApp({
    captain: createStubCaptain(),
    get workerMcp() {
      return worker;
    },
  });
  const request = {
    principalId: "worker",
    workId: "issue",
    server: "linear",
    tools: [{ name: "comment", arguments: { issueId: "issue" } }],
    swarm: { conversationId: "lead", taskId: "task" },
    ttlSeconds: 60,
  };
  const headers = (token: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  const renew = (token: string) =>
    app.app.request("/v1/worker-mcp/renew", { method: "POST", headers: headers(token) });
  const claim = (id: string, capability: string) =>
    app.app.request(`/v1/worker-mcp/claim/${id}`, { method: "POST", headers: headers(capability) });
  const rpc = (token: string, method: string, params: unknown, sessionId?: string) =>
    app.app.request("/v1/worker-mcp", {
      method: "POST",
      headers: { ...headers(token), ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const swarmRpc = (
    token: string,
    method: string,
    params: unknown,
    sessionId?: string,
    connection?: string,
  ) =>
    app.app.request(`/v1/worker-mcp/swarm/scope${connection ? `?connection=${connection}` : ""}`, {
      method: "POST",
      headers: { ...headers(token), ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  let changes = 0;
  let enrolledClient: Client;
  const initializeWorker = async () => {
    enrolledClient = new Client({ name: "enrolled-worker", version: "1" });
    enrolledClient.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changes++;
    });
    const transport = new StreamableHTTPClientTransport(new URL("http://service/v1/worker-mcp/swarm/scope"), {
      requestInit: { headers: { authorization: "Bearer worker-session" } },
      fetch: async (input, init) => app.app.request(new Request(input, init)),
    });
    await enrolledClient.connect(transport as unknown as Transport);
    return transport.sessionId!;
  };
  let enrolledSession = await initializeWorker();
  const enrolledTools = async () => (await enrolledClient.listTools()).tools;
  try {
    expect(await enrolledTools()).toEqual([]);
    expect((await swarmRpc("operator-token", "tools/list", {}, enrolledSession)).status).toBe(403);
    expect((await swarmRpc("other-worker", "tools/list", {}, enrolledSession)).status).toBe(403);
    await expect(worker.issue({ ...request, swarm: undefined, renewable: true })).rejects.toThrow(
      "requires a Swarm",
    );
    const manual = await worker.issue({ ...request, ttlSeconds: 900 });
    expect((await renew(manual.token)).status).toBe(403);
    const initial = await worker.issue({ ...request, renewable: true });
    await expect.poll(() => changes).toBe(2);
    expect((await enrolledTools()).map((tool: { name: string }) => tool.name)).toEqual(["linear_comment"]);
    const enrolledCall = async (issueId: string) =>
      (
        await (
          await swarmRpc(
            "worker-session",
            "tools/call",
            { name: "linear_comment", arguments: { issueId } },
            enrolledSession,
          )
        ).json()
      ).result;
    expect((await enrolledCall("issue")).isError).toBe(false);
    expect((await enrolledCall("other")).isError).toBe(true);
    for (const capability of ["other-worker", "other-scope", "operator-token", initial.token])
      expect((await claim(initial.grant.grantId, capability)).status).toBe(403);
    const delivery = await claim(initial.grant.grantId, "worker-session");
    expect(delivery.status).toBe(200);
    expect(delivery.headers.get("cache-control")).toBe("no-store");
    expect((await delivery.json()).grant.grantId).toBe(initial.grant.grantId);
    const initialize = await rpc(initial.token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "worker", version: "1" },
    });
    const session = initialize.headers.get("mcp-session-id")!;
    const clock = vi.spyOn(Date, "now").mockReturnValue((initial.grant.issuedAt + 40) * 1000);
    const response = await renew(initial.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const renewed = await response.json();
    expect(renewed.grant).toEqual({
      ...initial.grant,
      issuedAt: initial.grant.issuedAt + 40,
      expiresAt: initial.grant.expiresAt + 40,
    });
    clock.mockReturnValue((initial.grant.expiresAt + 1) * 1000);
    expect((await renew(initial.token)).status).toBe(403);
    // Another worker's request must not collect the renewed but idle session.
    expect(
      (
        await rpc(manual.token, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "other", version: "1" },
        })
      ).status,
    ).toBe(200);
    const listed = await (await rpc(renewed.token, "tools/list", {}, session)).json();
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["linear_comment"]);
    const allowed = await (
      await rpc(
        renewed.token,
        "tools/call",
        { name: "linear_comment", arguments: { issueId: "issue" } },
        session,
      )
    ).json();
    expect(allowed.result.isError).toBe(false);
    const refused = await (
      await rpc(
        renewed.token,
        "tools/call",
        { name: "linear_comment", arguments: { issueId: "other" } },
        session,
      )
    ).json();
    expect(refused.result.isError).toBe(true);
    active = false;
    expect(await enrolledTools()).toEqual([]);
    expect((await enrolledCall("issue")).isError).toBe(true);
    expect((await renew(renewed.token)).status).toBe(403);
    expect((await claim(initial.grant.grantId, "worker-session")).status).toBe(403);
    active = true;
    binding = "replacement-account";
    expect(await enrolledTools()).toEqual([]);
    expect((await renew(renewed.token)).status).toBe(403);
    expect((await claim(initial.grant.grantId, "worker-session")).status).toBe(403);
    binding = "account-1";
    await enrolledClient!.close();
    await worker.close();
    worker = new WorkerMcp(options);
    enrolledSession = await initializeWorker();
    expect((await renew(renewed.token)).status).toBe(200);
    clock.mockReturnValue((manual.grant.expiresAt + 1) * 1000);
    expect((await claim(manual.grant.grantId, "worker-session")).status).toBe(403);
    // A fresh enrolled session authenticates delivery independently of an expired token.
    expect((await renew(renewed.token)).status).toBe(403);
    expect((await claim(initial.grant.grantId, "worker-session")).status).toBe(200);
    expect(await enrolledTools()).toHaveLength(1);
    await worker.revoke(initial.grant.grantId);
    await expect.poll(() => changes).toBe(3);
    expect(await enrolledTools()).toEqual([]);
    expect((await enrolledCall("issue")).isError).toBe(true);
    expect((await claim(initial.grant.grantId, "worker-session")).status).toBe(403);
    expect((await renew(renewed.token)).status).toBe(403);
    expect((await rpc(renewed.token, "initialize", {})).status).toBe(403);
    expect(await worker.list()).toHaveLength(2);
    const external = await worker.issue({
      ...request,
      swarm: { ...request.swarm, connectionId: "alpha" },
      renewable: true,
    });
    expect(await enrolledTools()).toEqual([]);
    const initialized = await swarmRpc(
      "worker-session",
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "external-worker", version: "1" },
      },
      undefined,
      "alpha",
    );
    expect(initialized.status).toBe(200);
    const externalSession = initialized.headers.get("mcp-session-id")!;
    expect(
      (await (await swarmRpc("worker-session", "tools/list", {}, externalSession, "alpha")).json()).result
        .tools,
    ).toHaveLength(1);
    expect((await swarmRpc("worker-session", "tools/list", {}, externalSession, "beta")).status).toBe(403);
    expect((await swarmRpc("worker-session", "tools/list", {}, enrolledSession, "alpha")).status).toBe(403);
    await worker.revoke(external.grant.grantId);
    expect(
      (await (await swarmRpc("worker-session", "tools/list", {}, externalSession, "alpha")).json()).result
        .tools,
    ).toEqual([]);
    expect(changes).toBe(3);
  } finally {
    await enrolledClient!.close();
    app.close();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
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
  let fence = 1;
  let active = true;
  const options = {
    directory: join(root, "grants"),
    credentials,
    host,
    swarm: {
      async assignment(conversationId: string, taskId: string, actor: string) {
        if (!active) throw new Error("Work no longer active");
        return { conversationId, taskId, actor, scope: "project", attemptId: "attempt-1", fence };
      },
    },
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
    swarm: { conversationId: "lead", taskId: "swarm-task-1" },
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
    expect(JSON.stringify(first)).not.toContain("provider-secret");
    expect(JSON.stringify(await worker.list())).not.toContain(first.token);
    for (const method of ["GET", "POST", "DELETE"])
      expect(
        (await app.app.request("/v1/worker-grants/", { method, headers: headers(first.token) })).status,
      ).toBe(401);
    expect((await app.app.request("/v1/swarm", { headers: headers(first.token) })).status).toBe(401);
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
    fence = 2;
    expect((await rpc(second.token, "tools/list", {}, restored)).status).toBe(403);
    fence = 1;
    active = false;
    expect((await rpc(second.token, "tools/list", {}, restored)).status).toBe(403);
    await expect(worker.issue(request("third"))).rejects.toThrow("no longer active");
    active = true;
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
