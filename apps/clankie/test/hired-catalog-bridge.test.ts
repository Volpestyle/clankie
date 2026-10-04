import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

async function bridge(expected: string | undefined, catalog: (cursor?: string) => unknown | undefined) {
  const home = await mkdtemp(join(tmpdir(), "hired-catalog-bridge-"));
  let calls = 0;
  const http = createServer((request, response) => {
    let bytes = "";
    request.on("data", (chunk) => (bytes += String(chunk)));
    request.on("end", () => {
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
      else if (rpc.method === "tools/list") result = catalog(rpc.params?.cursor);
      else {
        calls++;
        response.writeHead(403);
        response.end("{}");
        return;
      }
      if (result === undefined) {
        response.writeHead(403);
        response.end("{}");
        return;
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  await mkdir(join(home, ".clankie", "links"), { recursive: true });
  await writeFile(
    join(home, ".clankie", "links", "pc.json"),
    JSON.stringify({
      schemaVersion: 2,
      authentication: "local-process",
      fleet: "pc",
      socket: "fixture",
      url: `http://127.0.0.1:${port}`,
    }),
  );
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
      `import {runSeatChannel} from ${JSON.stringify(module)};runSeatChannel({paneId:"w1:p1",parentArgv:"codex app-server"});`,
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
    await expect(f.client.listTools()).rejects.toThrow("expected granted catalog");
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

it("bounds denied and incomplete-page startup with MCP errors, while no expectation retains the generic fallback", async () => {
  const rows = await Promise.all([
    bridge('["clankie_tools"]', () => undefined),
    bridge('["clankie_tools"]', (cursor) =>
      cursor ? undefined : { tools: [tool("clankie_tools")], nextCursor: "denied-page" },
    ),
    bridge(undefined, () => undefined),
  ]);
  const started = performance.now();
  try {
    const results = await Promise.allSettled(rows.map((f) => f.client.listTools({}, { timeout: 25_000 })));
    expect(performance.now() - started).toBeGreaterThanOrEqual(19_000);
    expect(performance.now() - started).toBeLessThan(24_000);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("expected granted catalog") }),
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("expected granted catalog") }),
    });
    expect(results[2]).toMatchObject({
      status: "fulfilled",
      value: { tools: [{ name: "message_clankie" }] },
    });
  } finally {
    await Promise.all(rows.map((f) => f.close()));
  }
}, 30_000);
