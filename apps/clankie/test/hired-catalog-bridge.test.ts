import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { assertMcpToolsList } from "../src/mcp-tool-schema.ts";
import { expect, it } from "vitest";

async function bridge(
  expected: string | undefined,
  catalog: (cursor?: string) => unknown | undefined,
  linked = true,
  requestTimeoutMs?: number,
  peers = false,
) {
  const home = await mkdtemp(join(tmpdir(), "hired-catalog-bridge-"));
  let calls = 0;
  const http = createServer((request, response) => {
    let bytes = "";
    request.on("data", (chunk) => (bytes += String(chunk)));
    request.on("end", () => {
      if (request.url?.endsWith("/peers")) {
        response.setHeader("content-type", "application/json");
        if (peers)
          response.end(
            JSON.stringify({
              schemaVersion: 1,
              fleet: "pc",
              sender: { seatId: "term-fixture", paneId: "w1:p1", binding: "a".repeat(64) },
              seats: [],
            }),
          );
        else {
          response.writeHead(403);
          response.end(JSON.stringify({ error: "peer_messages_disabled" }));
        }
        return;
      }
      if (request.url !== "/v1/fleet/mcp") {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      const rpc = JSON.parse(bytes);
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "fixture");
      if (rpc.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      let result;
      if (rpc.method === "initialize")
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
      else if (rpc.method === "tools/list") {
        const listed = catalog(rpc.params?.cursor) as Record<string, unknown> | undefined;
        result = listed && {
          ...listed,
          _meta: listed._meta ?? { clankie: { tools: "connected" } },
        };
      } else {
        calls++;
        response.writeHead(403);
        response.end(JSON.stringify({ error: "fleet_admission_pending" }));
        return;
      }
      if (result === undefined) {
        response.writeHead(403);
        response.end(JSON.stringify({ error: "fleet_admission_pending" }));
        return;
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  await mkdir(join(home, ".clankie", "links"), { recursive: true });
  const admit = () =>
    writeFile(
      join(home, ".clankie", "links", "pc.json"),
      JSON.stringify({
        schemaVersion: 2,
        authentication: "local-process",
        fleet: "pc",
        socket: "fixture",
        url: `http://127.0.0.1:${port}`,
      }),
    );
  if (linked) await admit();
  const module = new URL("../../../integrations/claude-plugin/worker/bin/seat-channel.mjs", import.meta.url)
    .href;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => name !== "CLANKIE_EXPECTED_TOOL_NAMES" && value !== undefined,
    ),
  ) as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      `import {runSeatChannel} from ${JSON.stringify(module)};runSeatChannel({paneId:"w1:p1",parentArgv:"codex app-server",requestTimeoutMs:${String(requestTimeoutMs)}});`,
    ],
    env: {
      ...env,
      HOME: home,
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "fixture",
      ...(expected === undefined ? {} : { CLANKIE_EXPECTED_TOOL_NAMES: expected }),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "native-startup-surrogate", version: "1" });
  await client.connect(transport);
  return {
    client,
    admit,
    calls: () => calls,
    close: async () => {
      await client.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    },
  };
}
const tool = (name: string) => ({ name, inputSchema: { type: "object" } });

it("adopts fleet membership after startup and emits a list-change notification including the message tool", async () => {
  const f = await bridge(undefined, () => ({ tools: [tool("clankie_tools"), tool("clankie_call")] }), false);
  try {
    expect((await f.client.listTools()).tools).toEqual([]);
    const notified = new Promise<void>((resolve) =>
      f.client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()),
    );
    await f.admit();
    await notified;
    expect((await f.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "message_clankie",
      "clankie_tools",
      "clankie_call",
    ]);
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
}, 10_000);

it("requires all expected paginated tools before a native Connected surrogate can succeed, and never grants from the hint", async () => {
  let admitted = false;
  const pages: string[] = [];
  const f = await bridge(JSON.stringify(["clankie_tools", "clankie_call"]), (cursor) => {
    if (!admitted) return undefined;
    pages.push(cursor ?? "first");
    return cursor
      ? { tools: [tool("clankie_call")] }
      : { tools: [tool("clankie_tools")], nextCursor: "second" };
  });
  let connected = false;
  try {
    const pending = f.client.listTools().then((result) => {
      connected = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connected).toBe(false);
    admitted = true;
    expect((await pending).tools.map((t) => t.name)).toEqual([
      "message_clankie",
      "clankie_tools",
      "clankie_call",
    ]);
    expect(pages).toEqual(["first", "second"]);
    expect(connected).toBe(true);
    expect((await f.client.callTool({ name: "clankie_tools", arguments: { id: "fixture" } })).isError).toBe(
      true,
    );
    expect(f.calls()).toBe(1);
    admitted = false;
    expect((await f.client.listTools()).tools.map((t) => t.name)).toEqual([
      "message_clankie",
      "clankie_tools",
      "clankie_call",
    ]);
    expect(f.calls()).toBe(1);
  } finally {
    await f.close();
  }
});

it.each(["{", "null", '"clankie_tools"', '[""]', "[42]"])(
  "fails malformed deny-only expectations without exposing a successful catalog: %s",
  async (expected) => {
    const f = await bridge(expected, () => ({ tools: [tool("clankie_tools")] }));
    try {
      await expect(f.client.listTools()).rejects.toThrow("Invalid Clankie tool catalog expectation");
      expect(f.calls()).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it("bounds denied and incomplete-page startup with the real MCP error, including a worker without expectations", async () => {
  const rows = await Promise.all([
    bridge('["clankie_tools"]', () => undefined, true, 500),
    bridge(
      '["clankie_tools"]',
      (cursor) => (cursor ? undefined : { tools: [tool("clankie_tools")], nextCursor: "denied-page" }),
      true,
      500,
    ),
    bridge(undefined, () => undefined, true, 500),
  ]);
  const started = performance.now();
  try {
    const results = await Promise.allSettled(rows.map((f) => f.client.listTools({}, { timeout: 2_000 })));
    expect(performance.now() - started).toBeGreaterThanOrEqual(450);
    expect(performance.now() - started).toBeLessThan(1_500);
    for (const result of results)
      expect(result).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: expect.stringContaining("403: fleet_admission_pending") }),
      });
  } finally {
    await Promise.all(rows.map((f) => f.close()));
  }
});

it("strict client contract: fleet stdio tools/list includes mailbox, peers and connected tools", async () => {
  const f = await bridge(
    undefined,
    () => ({ tools: [tool("clankie_tools"), tool("clankie_call")] }),
    true,
    undefined,
    true,
  );
  try {
    const listed = await f.client.listTools();
    assertMcpToolsList(listed, "fleet stdio bridge");
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "message_clankie",
      "clankie_tools",
      "clankie_call",
      "list_fleet_seats",
      "message_peer",
    ]);
  } finally {
    await f.close();
  }
});
