import { mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { runAccessCommand } from "../src/command/access.ts";
import { parseMcpArgs, runMcpCommand } from "../src/command/mcp.ts";
import { runWorkerMcp } from "../src/command/worker-mcp.ts";

it("delivers a private worker grant without printing it, and revokes failed deliveries", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-access-cli-"));
  const request = join(root, "request.json"),
    output = join(root, "grant.json");
  const methods: string[] = [];
  let revokeOk = true;
  const options = {
    host: "http://127.0.0.1:4310",
    env: { CLANKIE_OPERATOR_TOKEN: "test-owner" },
    fetchImpl: (async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-owner");
      methods.push(init!.method!);
      return init?.method === "DELETE"
        ? Response.json({}, { status: revokeOk ? 200 : 503 })
        : Response.json({
            token: "worker-secret",
            grant: { grantId: "grant-id" },
            account: { email: "bot@example.com" },
          });
    }) as typeof fetch,
  };
  try {
    await writeFile(request, JSON.stringify({ principalId: "worker" }));
    const result = await runAccessCommand(["issue", request, "--out", output], options);
    expect(JSON.stringify(result)).not.toContain("worker-secret");
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      endpoint: "http://127.0.0.1:4310/v1/worker-mcp",
      token: "worker-secret",
    });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(runAccessCommand(["issue", request, "--out", output], options)).rejects.toThrow(/exist/iu);
    expect(methods).toEqual(["POST", "POST", "DELETE"]);
    revokeOk = false;
    await expect(runAccessCommand(["issue", request, "--out", output], options)).rejects.toThrow(
      /revocation is unconfirmed.*grant-id/u,
    );
    expect(parseMcpArgs(["--grant", output])).toEqual({ grantFile: output });
    expect(() => parseMcpArgs(["--grant", output, "--lane", "operator"])).toThrow();
    expect(() => parseMcpArgs(["--grant", output, "--seat"])).toThrow();
    await writeFile(join(root, "public.json"), "{}", { mode: 0o644 });
    await expect(runWorkerMcp(join(root, "public.json"))).rejects.toThrow(/private/u);
    await writeFile(
      join(root, "remote.json"),
      JSON.stringify({ endpoint: "http://remote.example/mcp", token: "worker-secret" }),
      { mode: 0o600 },
    );
    await expect(runWorkerMcp(join(root, "remote.json"))).rejects.toThrow(/HTTPS/u);
    await expect(runAccessCommand(["issue", request, "--deliver", "swarm"], options)).rejects.toThrow(
      "assignment-bound",
    );
    await writeFile(
      request,
      JSON.stringify({ principalId: "worker", swarm: { conversationId: "lead", taskId: "task" } }),
    );
    const delivered = await runAccessCommand(["issue", request, "--deliver", "swarm"], options);
    expect(JSON.stringify(delivered)).not.toContain("worker-secret");
    expect(delivered).toMatchObject({ workerCommand: ["clankie", "mcp", "--swarm-grant", "grant-id"] });
    expect(() => parseMcpArgs(["--swarm-grant", "id", "--lane", "operator"])).toThrow();
    await expect(
      runMcpCommand(["--swarm-grant", randomUUID()], { env: { CLANKIE_OPERATOR_TOKEN: "owner-only" } }),
    ).rejects.toThrow("SWARM_SESSION_CAPABILITY");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { renewable: false, swarm: false },
  { renewable: true, swarm: false },
  { renewable: false, swarm: true },
  { renewable: true, swarm: true },
])("bridges only worker tools: %j", async ({ renewable, swarm }) => {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-bridge-"));
  const file = join(root, "grant.json");
  const upstream = new Server({ name: "worker-service", version: "1" }, { capabilities: { tools: {} } });
  upstream.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "linear_comment", inputSchema: { type: "object" } }],
  }));
  upstream.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: JSON.stringify(request.params.arguments) }],
  }));
  const http = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => "session",
    enableJsonResponse: true,
  });
  const client = new Client({ name: "test-worker", version: "1" });
  const [clientTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
  let token = "only-worker-token",
    renewals = 0,
    revoked = false;
  const validTokens = new Set([token]);
  let lastBearer: string | null = null;
  let outcome: Promise<unknown> | undefined;
  const issuedAt = Math.floor(Date.now() / 1000);
  const capability = {
    version: 1,
    grantId: randomUUID(),
    principalId: "worker",
    missionId: "work",
    profileHash: "binding",
    capabilities: ["comment"],
    resources: ["linear"],
    obligations: [],
    nonce: "nonce-123",
    issuedAt,
    expiresAt: issuedAt + 2,
  };
  try {
    await upstream.connect(http as unknown as Transport);
    await writeFile(
      file,
      JSON.stringify({
        endpoint: "http://127.0.0.1:4310/v1/worker-mcp",
        token,
        grant: capability,
        renewable,
      }),
      { mode: 0o600 },
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === `http://127.0.0.1:4310/v1/worker-mcp/claim/${capability.grantId}`) {
        expect(request.headers.get("authorization")).toBe("Bearer runtime-session");
        return Response.json({ token, grant: capability, renewable });
      }
      lastBearer = request.headers.get("authorization");
      expect(validTokens.has(lastBearer?.replace(/^Bearer /u, "") ?? "")).toBe(true);
      if (request.url.endsWith("/renew")) {
        if (revoked) return Response.json({}, { status: 403 });
        renewals++;
        token = `renewed-worker-${renewals}`;
        validTokens.add(token);
        const issuedAt = Math.floor(Date.now() / 1000);
        return Response.json({
          token,
          renewable: true,
          grant: { ...capability, issuedAt, expiresAt: issuedAt + 2 },
        });
      }
      expect(request.url).toBe("http://127.0.0.1:4310/v1/worker-mcp");
      return http.handleRequest(request);
    });
    const linked = `${file}.link`;
    await symlink(file, linked);
    const running = swarm
      ? runMcpCommand(["--swarm-grant", capability.grantId], {
          env: {
            CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:4310",
            SWARM_SESSION_CAPABILITY: "runtime-session",
            CLANKIE_OPERATOR_TOKEN: "must-not-use",
          },
          transport: bridgeTransport,
        })
      : runWorkerMcp(linked, bridgeTransport);
    outcome = running.then(
      (code) => code,
      (error: unknown) => error,
    );
    await client.connect(clientTransport);
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["linear_comment"]);
    expect(
      await client.callTool({ name: "linear_comment", arguments: { issueId: "issue-1" } }),
    ).toMatchObject({ content: [{ text: '{"issueId":"issue-1"}' }] });
    if (renewable) {
      await expect
        .poll(async () => (swarm ? token : JSON.parse(await readFile(file, "utf8")).token))
        .toMatch(/^renewed-worker-/u);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readlink(linked)).toBe(file);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["linear_comment"]);
      await expect
        .poll(async () => {
          await client.listTools();
          return lastBearer;
        })
        .toMatch(/^Bearer renewed-worker-/u);
      revoked = true;
      expect(await outcome).toBeInstanceOf(Error);
    } else {
      await client.close();
      expect(await outcome).toBe(0);
      expect(renewals).toBe(0);
    }
  } finally {
    await client.close();
    await outcome;
    await upstream.close();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps an enrolled worker connected as grants change, without loading operator credentials", async () => {
  expect(parseMcpArgs(["--swarm"])).toEqual({ swarm: true });
  expect(() => parseMcpArgs(["--swarm", "--lane", "operator"])).toThrow();
  await expect(runMcpCommand(["--swarm"], { env: { CLANKIE_OPERATOR_TOKEN: "owner" } })).rejects.toThrow(
    "SWARM_SESSION_CAPABILITY",
  );
  const upstream = new Server(
    { name: "worker-service", version: "1" },
    { capabilities: { tools: { listChanged: true } } },
  );
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) =>
    interval(fn, 10)) as typeof setInterval);
  let pings = 0;
  upstream.setRequestHandler(PingRequestSchema, async () => {
    pings++;
    return {};
  });
  let granted = false;
  upstream.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: granted ? [{ name: "linear_comment", inputSchema: { type: "object" } }] : [],
  }));
  const http = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => "enrolled",
    enableJsonResponse: true,
  });
  const client = new Client({ name: "worker", version: "1" });
  const [clientTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
  let running: Promise<number> | undefined;
  try {
    await upstream.connect(http as unknown as Transport);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe("http://127.0.0.1:4310/v1/worker-mcp/swarm/project");
      expect(request.headers.get("authorization")).toBe("Bearer worker-session");
      return http.handleRequest(request);
    });
    running = runMcpCommand(["--swarm"], {
      env: {
        SWARM_SESSION_CAPABILITY: "worker-session",
        SWARM_SCOPE: "project",
        CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:4310",
        CLANKIE_OPERATOR_TOKEN: "must-not-use",
      },
      transport: bridgeTransport,
    });
    let changes = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changes++;
    });
    await client.connect(clientTransport);
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
    expect((await client.listTools()).tools).toEqual([]);
    granted = true;
    await upstream.sendToolListChanged();
    await expect.poll(() => changes).toBe(1);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["linear_comment"]);
    await expect.poll(() => pings).toBeGreaterThan(0);
    granted = false;
    await upstream.sendToolListChanged();
    await expect.poll(() => changes).toBe(2);
    expect((await client.listTools()).tools).toEqual([]);
    await client.close();
    expect(await running).toBe(0);
  } finally {
    await client.close();
    await bridgeTransport.close();
    await running;
    await upstream.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
