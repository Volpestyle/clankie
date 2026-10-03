import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bridges only the manual grant's tools and refuses retired command modes", async () => {
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
  let running: Promise<number> | undefined;
  try {
    for (const args of [["--swarm"], ["--swarm-grant", "id"]]) {
      expect(() => parseMcpArgs(args)).toThrow("Usage");
      await expect(runMcpCommand(args)).rejects.toThrow("Usage");
    }
    await upstream.connect(http as unknown as Transport);
    await writeFile(
      file,
      JSON.stringify({ endpoint: "http://127.0.0.1:4310/v1/worker-mcp", token: "only-worker-token" }),
      { mode: 0o600 },
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer only-worker-token");
      return http.handleRequest(request);
    });
    running = runWorkerMcp(file, bridgeTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["linear_comment"]);
    expect(
      (await client.callTool({ name: "linear_comment", arguments: { issueId: "issue" } })).content,
    ).toEqual([{ type: "text", text: '{"issueId":"issue"}' }]);
    await client.close();
    expect(await running).toBe(0);
  } finally {
    await client.close();
    await running;
    await upstream.close();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
