import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { assertMcpToolsList } from "../src/mcp-tool-schema.ts";
import { expect, it } from "vitest";

async function bridge(
  expected: string | undefined,
  catalog: (cursor?: string) => unknown | undefined | Promise<unknown | undefined>,
  linked = true,
  requestTimeoutMs?: number,
  peers = false,
  messageRoute?: (request: IncomingMessage, response: ServerResponse, bytes: string) => boolean,
) {
  const home = await mkdtemp(join(tmpdir(), "hired-catalog-bridge-"));
  let calls = 0;
  const http = createServer((request, response) => {
    let bytes = "";
    request.on("data", (chunk) => (bytes += String(chunk)));
    request.on("end", async () => {
      if (messageRoute?.(request, response, bytes)) return;
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
        const listed = (await catalog(rpc.params?.cursor)) as Record<string, unknown> | undefined;
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

it("refreshes unchanged schemas after a runtime revision and retains both peer tools", async () => {
  let revision = "before-deploy";
  const f = await bridge(
    undefined,
    () => ({
      tools: [tool("clankie_tools"), tool("clankie_call")],
      _meta: {
        clankie: {
          tools: "connected",
          peerMessages: "on",
          runtimeRevision: revision,
          pluginVersion: "0.6.7",
        },
      },
    }),
    true,
    undefined,
    true,
  );
  try {
    const before = await f.client.listTools();
    const notified = new Promise<void>((resolve) =>
      f.client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()),
    );
    revision = "after-deploy";
    await notified;
    const after = await f.client.listTools();
    expect(after.tools).toEqual(before.tools);
    expect(after.tools.map((row) => row.name)).toEqual([
      "message_clankie",
      "clankie_tools",
      "clankie_call",
      "list_fleet_seats",
      "message_peer",
    ]);
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
}, 10_000);

it("holds a deploy revision while the original native session is busy outside MCP", async () => {
  let revision = "before",
    hold = false,
    notified = false;
  const f = await bridge(
    undefined,
    () => ({
      tools: [tool("clankie_tools"), tool("clankie_call")],
      _meta: {
        clankie: {
          tools: "connected",
          peerMessages: "on",
          runtimeRevision: revision,
          pluginVersion: "0.6.7",
          refreshPending: hold,
        },
      },
    }),
    true,
    undefined,
    true,
  );
  try {
    const before = await f.client.listTools();
    let changed!: () => void;
    const changedPromise = new Promise<void>((resolve) => {
      changed = resolve;
    });
    f.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified = true;
      changed();
    });
    revision = "after";
    hold = true;
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(notified).toBe(false);
    expect((await f.client.listTools()).tools).toEqual(before.tools);
    hold = false;
    await changedPromise;
    expect((await f.client.listTools()).tools).toEqual(before.tools);
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
}, 15_000);

it("waits for an in-flight report before reconciling once or notifying the native client", async () => {
  let revision = "before",
    reads = 0,
    notifications = 0;
  let release!: () => void, started!: () => void;
  const posting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await bridge(
    undefined,
    () => ({
      tools: [tool("clankie_tools"), tool("clankie_call")],
      _meta: {
        clankie: {
          tools: "connected",
          peerMessages: revision === "before" ? "off" : "on",
          runtimeRevision: revision,
          pluginVersion: "0.6.7",
        },
      },
    }),
    true,
    undefined,
    false,
    (request, response) => {
      if (!request.url?.includes("/messages")) return false;
      response.setHeader("content-type", "application/json");
      if (request.method === "POST") {
        release = () => {
          if (!response.writableEnded) {
            response.writeHead(503);
            response.end("{}");
          }
        };
        started();
      } else if (request.url.endsWith("/messages")) response.end(JSON.stringify({ binding: "a".repeat(64) }));
      else {
        reads += 1;
        response.end("{}");
      }
      return true;
    },
  );
  try {
    await f.client.listTools();
    let notify!: () => void;
    const notified = new Promise<void>((resolve) => {
      notify = resolve;
    });
    f.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications += 1;
      notify();
    });
    const original = f.client.callTool({
      name: "message_clankie",
      arguments: { text: "Original active report" },
    });
    await posting;
    revision = "after";
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(reads).toBe(0);
    expect(notifications).toBe(0);
    expect((await f.client.listTools()).tools.map((row) => row.name)).toEqual([
      "message_clankie",
      "clankie_tools",
      "clankie_call",
    ]);
    release();
    await original;
    await notified;
    expect(reads).toBe(1);
    expect((await f.client.listTools()).tools.map((row) => row.name)).toContain("message_peer");
    const later = await f.client.callTool({
      name: "message_clankie",
      arguments: { text: "Separate later report" },
    });
    expect(later.isError).toBe(true);
    expect(reads).toBe(1);
    expect(notifications).toBe(1);
  } finally {
    release?.();
    await f.close();
  }
}, 12_000);

it("keeps the published snapshot when a call starts during a catalog lookup", async () => {
  let revision = "before",
    hold = false;
  let releaseCatalog!: () => void, releasePost!: () => void;
  let lookupStarted!: () => void, postStarted!: () => void;
  const looking = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const posting = new Promise<void>((resolve) => {
    postStarted = resolve;
  });
  const f = await bridge(
    undefined,
    async () => {
      if (hold) {
        hold = false;
        lookupStarted();
        await new Promise<void>((resolve) => {
          releaseCatalog = resolve;
        });
      }
      return {
        tools: [tool("clankie_tools"), tool("clankie_call")],
        _meta: {
          clankie: {
            tools: "connected",
            peerMessages: revision === "before" ? "off" : "on",
            runtimeRevision: revision,
            pluginVersion: "0.6.7",
          },
        },
      };
    },
    true,
    undefined,
    false,
    (request, response) => {
      if (!request.url?.includes("/messages")) return false;
      response.setHeader("content-type", "application/json");
      if (request.method === "POST") {
        releasePost = () => {
          if (!response.writableEnded) {
            response.writeHead(503);
            response.end("{}");
          }
        };
        postStarted();
      } else if (request.url.endsWith("/messages")) response.end(JSON.stringify({ binding: "a".repeat(64) }));
      else response.end("{}");
      return true;
    },
  );
  try {
    const before = await f.client.listTools();
    revision = "after";
    hold = true;
    const pending = f.client.listTools();
    await looking;
    const active = f.client.callTool({ name: "message_clankie", arguments: { text: "Held original" } });
    await posting;
    releaseCatalog();
    expect((await pending).tools).toEqual(before.tools);
    releasePost();
    await active;
    expect((await f.client.listTools()).tools.map((row) => row.name)).toContain("message_peer");
  } finally {
    releaseCatalog?.();
    releasePost?.();
    await f.close();
  }
});

it("reports the catalog actually published to the native client rather than background discovery", async () => {
  let revision = "before";
  const reports: Array<{ runtimeRevision?: string; tools: string[] }> = [];
  const f = await bridge(
    undefined,
    () => ({
      tools: [tool("clankie_tools"), tool("clankie_call")],
      _meta: {
        clankie: {
          tools: "connected",
          peerMessages: revision === "before" ? "off" : "on",
          runtimeRevision: revision,
          pluginVersion: "0.6.7",
        },
      },
    }),
    true,
    undefined,
    false,
    (request, response, bytes) => {
      if (request.url !== "/v1/fleet/mcp") return false;
      const rpc = JSON.parse(bytes);
      if (rpc.method === "notifications/clankie/bridge_status") reports.push(rpc.params);
      if (rpc.method !== "tools/call") return false;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { content: [{ type: "text", text: "Accepted" }] },
        }),
      );
      return true;
    },
  );
  const observed = async (expected: string) => {
    for (let i = 0; i < 100 && reports.at(-1)?.runtimeRevision !== expected; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reports.at(-1)?.runtimeRevision).toBe(expected);
  };
  try {
    await f.client.listTools();
    await observed("before");
    const changed = new Promise<void>((resolve) =>
      f.client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()),
    );
    revision = "after";
    await changed;
    await f.client.callTool({ name: "clankie_tools", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reports.at(-1)).toMatchObject({
      runtimeRevision: "before",
      tools: ["message_clankie", "clankie_tools", "clankie_call"],
    });
    await f.client.listTools();
    await observed("after");
    expect(reports.at(-1)?.tools).toContain("message_peer");
  } finally {
    await f.close();
  }
}, 10_000);

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
