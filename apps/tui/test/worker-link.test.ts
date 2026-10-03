import { fleetLinkFetch } from "../../clankie/src/fleet-link.ts";
import { createHash } from "node:crypto";
import { ConversationStore } from "../../clankie/src/captain/conversations.ts";
import { InboundSeatReceipts } from "../../clankie/src/captain/inbound-seat-receipts.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const bin = join(import.meta.dirname, "..", "..", "..", "integrations", "claude-plugin", "worker", "bin");
const TOKEN = "t".repeat(43);

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly pane: string | undefined;
  readonly body: string;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A stand-in for Clankie's link listener: one event in the mailbox, then nothing. */
async function fakeService(
  dropAck = false,
  mcpReply?: (method: string) => "deny" | "empty" | "stall" | undefined,
) {
  const seen: Seen[] = [];
  let delivered = false;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += String(chunk)));
    request.on("end", () => {
      const wire = new Request(new URL(request.url ?? "/", "http://x"), { method: request.method ?? "GET" });
      const admitted = fleetLinkFetch(() => new Response(null, { status: 204 }))(wire) as Response;
      if (admitted.status !== 204) {
        response.statusCode = admitted.status;
        response.end("{}");
        return;
      }
      const path = new URL(request.url ?? "/", "http://x").pathname;
      seen.push({
        method: request.method ?? "",
        path,
        authorization: request.headers.authorization,
        pane: request.headers["x-clankie-pane"] as string | undefined,
        body,
      });
      response.setHeader("content-type", "application/json");
      if (path === "/v1/fleet/mcp") {
        // The fleet's granted tools, as Clankie's worker endpoint answers them.
        const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
        const reply = mcpReply?.(message.method);
        if (reply === "deny") {
          response.statusCode = 403;
          response.end("{}");
          return;
        }
        if (reply === "stall") return;
        response.setHeader("mcp-session-id", "session-1");
        if (message.id === undefined) {
          response.statusCode = 202;
          response.end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "w", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools:
                    reply === "empty" ? [] : [{ name: "linear_get_issue", inputSchema: { type: "object" } }],
                }
              : { content: [{ type: "text", text: `ran ${String(message.params?.name)}` }], isError: false };
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        return;
      }
      if (path.endsWith("/ack")) {
        if (dropAck) response.destroy();
        else
          response.end(JSON.stringify({ schemaVersion: 1, acknowledged: true, deliveryStage: "delivered" }));
        return;
      }
      if (path.endsWith("/events")) {
        const events = delivered
          ? []
          : [
              {
                id: "event-1",
                kind: "message",
                conversationId: "global-default",
                source: "captain",
                content: "Hello from Clankie",
                createdAt: "2026-10-03T00:00:00.000Z",
              },
            ];
        delivered = true;
        setTimeout(() => response.end(JSON.stringify({ schemaVersion: 1, events })), events.length ? 0 : 200);
        return;
      }
      if (request.method === "GET" && path.endsWith("/messages")) {
        response.end(JSON.stringify({ schemaVersion: 1, binding: "a".repeat(64) }));
        return;
      }
      if (!path.endsWith("/messages")) {
        response.end(JSON.stringify({ schemaVersion: 1, received: true }));
        return;
      }
      const input = JSON.parse(body);
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          received: true,
          deliveryStage: "stored",
          deliveryId: input.delivery.id,
          binding: input.delivery.binding,
          fingerprint: createHash("sha256").update(input.text).digest("hex"),
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => server.close());
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return { seen, url: `http://127.0.0.1:${String(address.port)}` };
}

const SOCKET = "/tmp/herdr-pc-default.sock";

/** A linked machine's home: this fleet's link, and another session's beside it. */
async function linkedHome(url: string, local = false): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "clankie-link-home-"));
  await mkdir(join(home, ".clankie", "links"), { recursive: true });
  await writeFile(
    join(home, ".clankie", "links", "pc.json"),
    JSON.stringify(
      local
        ? { schemaVersion: 2, fleet: "default", socket: SOCKET, url, authentication: "local-process" }
        : { schemaVersion: 1, fleet: "pc", socket: SOCKET, url, token: TOKEN },
    ),
  );
  await writeFile(
    join(home, ".clankie", "links", "kh2.json"),
    JSON.stringify({
      schemaVersion: 1,
      fleet: "kh2",
      socket: "/tmp/herdr-kh2.sock",
      url: "http://127.0.0.1:1",
      token: "k".repeat(43),
    }),
  );
  return home;
}

describe("the worker plugin on a linked machine (VUH-1527)", () => {
  it.each(["ssh", "local"])("serves the seat channel and granted tools through the %s link", async (kind) => {
    const service = await fakeService();
    const home = await linkedHome(service.url, kind === "local");
    const authorization = kind === "local" ? undefined : `Bearer ${TOKEN}`;
    const bridge = kind === "local" ? "fleet-mcp.mjs" : "swarm-mcp.mjs";
    // The shim reads its parent's command line, as it reads Claude's in a real
    // launch; this parent carries the approved channel flag.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `require("node:child_process").spawn(process.execPath, [${JSON.stringify(join(bin, bridge))}], { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0))`,
        "--",
        "--channels",
        "plugin:clankie-worker@clankie",
      ],
      { env: { PATH: process.env.PATH, HOME: home, HERDR_PANE_ID: "w8:p3", HERDR_SOCKET_PATH: SOCKET } },
    );
    cleanups.push(() => parent.kill());
    const lines: Record<string, unknown>[] = [];
    let buffered = "";
    parent.stdout.on("data", (chunk: Buffer) => {
      buffered += String(chunk);
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        lines.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
        buffered = buffered.slice(newline + 1);
      }
    });
    const write = (message: object) =>
      parent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const waitFor = async (match: (line: Record<string, unknown>) => boolean) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const found = lines.find(match);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no matching line in ${JSON.stringify(lines)}`);
    };

    write({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(await waitFor((line) => line.id === 1)).toMatchObject({
      result: { capabilities: { experimental: { "claude/channel": {} } } },
    });
    write({ method: "notifications/initialized" });
    expect(await waitFor((line) => line.method === "notifications/claude/channel")).toMatchObject({
      params: { content: "Hello from Clankie", meta: { kind: "message", event_id: "event-1" } },
    });
    write({ id: 2, method: "tools/list" });
    expect(await waitFor((line) => line.id === 2)).toMatchObject({
      result: { tools: [{ name: "message_clankie" }, { name: "linear_get_issue" }] },
    });
    // A granted tool is proxied to Clankie's service over the link.
    write({ id: 4, method: "tools/call", params: { name: "linear_get_issue", arguments: { id: "A-1" } } });
    expect(await waitFor((line) => line.id === 4)).toMatchObject({
      result: { isError: false, content: [{ text: "ran linear_get_issue" }] },
    });
    expect(
      service.seen
        .filter((request) => request.path === "/v1/fleet/mcp")
        .every((r) => r.authorization === authorization && (kind !== "local" || r.pane === "w8:p3")),
    ).toBe(true);
    write({
      id: 3,
      method: "tools/call",
      params: { name: "message_clankie", arguments: { text: "Blocked on X" } },
    });
    const receipt = await waitFor((line) => line.id === 3);
    expect(receipt).toMatchObject({ result: { isError: false } });
    expect(JSON.parse((receipt.result as { content: { text: string }[] }).content[0]!.text)).toMatchObject({
      received: true,
      deliveryStage: "stored",
    });

    const message = service.seen.find(
      (request) => request.method === "POST" && request.path.endsWith("/messages"),
    );
    expect(message).toMatchObject({
      method: "POST",
      path: "/v1/fleet/seats/w8%3Ap3/messages",
      authorization,
    });
    expect(JSON.parse(message!.body)).toMatchObject({
      schemaVersion: 1,
      text: "Blocked on X",
      delivery: { id: expect.any(String), binding: "a".repeat(64) },
    });
    expect(service.seen.find((request) => request.path.endsWith("/events"))?.authorization).toBe(
      authorization,
    );
  });

  it("does not poll the mailbox for a session that did not approve the channel", async () => {
    const service = await fakeService();
    const home = await linkedHome(service.url);
    const child = spawn(process.execPath, [join(bin, "swarm-mcp.mjs")], {
      env: { PATH: process.env.PATH, HOME: home, HERDR_PANE_ID: "w8:p3", HERDR_SOCKET_PATH: SOCKET },
    });
    cleanups.push(() => child.kill());
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stderr).toContain("not polling");
    expect(service.seen.some((request) => request.path.endsWith("/events"))).toBe(false);
  });

  it("serves no tools to a pane in a Herdr session none of his links name", async () => {
    const service = await fakeService();
    const home = await linkedHome(service.url);
    const child = spawn(process.execPath, [join(bin, "swarm-mcp.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        HERDR_PANE_ID: "w1:p1",
        HERDR_SOCKET_PATH: "/tmp/other.sock",
      },
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
    child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.end();
    const [code] = (await once(child, "exit")) as [number];
    expect(code).toBe(0);
    expect(stderr).toContain("no link to Clankie for this Herdr session");
    expect(JSON.parse(stdout.trim())).toMatchObject({ id: 1, result: { tools: [] } });
    expect(service.seen).toEqual([]);
  });

  it("reports a settled turn over the link", async () => {
    const service = await fakeService();
    const home = await linkedHome(service.url);
    const child = spawn(process.execPath, [join(bin, "seat-hook.mjs")], {
      env: { PATH: process.env.PATH, HOME: home, HERDR_PANE_ID: "w8:p3", HERDR_SOCKET_PATH: SOCKET },
    });
    child.stdin.end(
      JSON.stringify({ hook_event_name: "Stop", session_id: "session-1", last_assistant_message: "Done." }),
    );
    await once(child, "exit");
    const hook = service.seen.find((request) => request.path.endsWith("/hook"));
    expect(hook).toMatchObject({ path: "/v1/fleet/seats/w8%3Ap3/hook", authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(hook!.body)).toEqual({
      schemaVersion: 1,
      event: "Stop",
      sessionId: "session-1",
      lastMessage: "Done.",
    });
  });
});

describe("the local link after a service restart", () => {
  it("follows the republished link when the old port refuses, without resending accepted calls", async () => {
    // A port that refuses connections: the service's listener before its restart.
    const dead = createServer();
    dead.listen(0, "127.0.0.1");
    await once(dead, "listening");
    const deadAddress = dead.address();
    if (typeof deadAddress !== "object" || deadAddress === null) throw new Error("no address");
    dead.close();
    await once(dead, "close");
    const home = await linkedHome(`http://127.0.0.1:${String(deadAddress.port)}`, true);
    const bridge = spawn(process.execPath, [join(bin, "fleet-mcp.mjs")], {
      env: { PATH: process.env.PATH, HOME: home, HERDR_PANE_ID: "w8:p3", HERDR_SOCKET_PATH: SOCKET },
    });
    cleanups.push(() => bridge.kill());
    const lines: Record<string, unknown>[] = [];
    let buffered = "";
    bridge.stdout.on("data", (chunk: Buffer) => {
      buffered += String(chunk);
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        lines.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
        buffered = buffered.slice(newline + 1);
      }
    });
    const write = (message: object) =>
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const waitFor = async (id: number) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const found = lines.find((line) => line.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no reply ${String(id)} in ${JSON.stringify(lines)}`);
    };
    write({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await waitFor(1);
    // The restarted service republishes its link on a new port.
    const service = await fakeService();
    await writeFile(
      join(home, ".clankie", "links", "pc.json"),
      JSON.stringify({
        schemaVersion: 2,
        fleet: "default",
        socket: SOCKET,
        url: service.url,
        authentication: "local-process",
      }),
    );
    write({ id: 2, method: "tools/call", params: { name: "linear_get_issue", arguments: { id: "A-1" } } });
    expect(await waitFor(2)).toMatchObject({
      result: { isError: false, content: [{ text: "ran linear_get_issue" }] },
    });
    const calls = service.seen.filter(
      (request) => request.path === "/v1/fleet/mcp" && request.body.includes("tools/call"),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pane).toBe("w8:p3");
  });
});

/** Real durable conversation acceptance behind the raw bridge's HTTP boundary. */
async function receiptService() {
  const root = await mkdtemp(join(tmpdir(), "bridge-inbound-service-"));
  const runner = vi.fn(async () => {});
  let store = new ConversationStore(join(root, "conversations"), runner);
  let receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
  let drop = true;
  let beforeAcceptance = false;
  let denyLookup = false;
  let legacyReply = false;
  const seen: { method: string; path: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://x");
      const admitted = fleetLinkFetch(() => new Response(null, { status: 204 }))(
        new Request(url, { method: request.method ?? "GET" }),
      ) as Response;
      if (admitted.status !== 204) {
        response.statusCode = admitted.status;
        response.end("{}");
        return;
      }
      seen.push({ method: request.method ?? "", path: url.pathname, body: raw });
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && url.pathname.endsWith("/messages")) {
        response.end(JSON.stringify({ schemaVersion: 1, binding: "a".repeat(64) }));
        return;
      }
      if (request.method === "GET") {
        if (denyLookup) {
          response.statusCode = 403;
          response.end("{}");
          return;
        }
        response.end(
          JSON.stringify(
            receipts.reconcile(
              "w8:p3",
              { id: url.pathname.split("/").at(-1)!, binding: url.searchParams.get("binding")! },
              url.searchParams.get("fingerprint")!,
            ),
          ),
        );
        return;
      }
      const input = JSON.parse(raw);
      if (beforeAcceptance)
        vi.spyOn(store, "submitInbound").mockImplementationOnce(() => {
          throw new Error("crash before acceptance");
        });
      const receipt = receipts.accept("w8:p3", input.delivery, input.text, `Agent output: ${input.text}`);
      if (drop) {
        response.destroy();
        return;
      }
      response.end(JSON.stringify(legacyReply ? { received: true } : receipt));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    runner,
    setDrop: (value: boolean) => {
      drop = value;
    },
    setPending: () => {
      beforeAcceptance = true;
    },
    setDenied: (value: boolean) => {
      denyLookup = value;
    },
    setLegacyReply: () => {
      legacyReply = true;
    },
    restart: async () => {
      await store.close();
      store = new ConversationStore(join(root, "conversations"), runner);
      receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
    },
  };
}
function rawReceiptBridge(mode: "fleet" | "seat", home: string, url: string, channel = false) {
  const code = `import { runMcpCommand } from ${JSON.stringify(new URL("../src/command/mcp.ts", import.meta.url).href)}; await runMcpCommand(["--seat"], { readParentArgv: async () => "test" });`;
  const child = spawn(
    process.execPath,
    mode === "fleet" ? [join(bin, "fleet-mcp.mjs")] : ["--input-type=module", "-e", code],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        HERDR_PANE_ID: "w8:p3",
        HERDR_SOCKET_PATH: SOCKET,
        CLANKIE_OPERATOR_TOKEN: "test-only",
        CLANKIE_CONTROL_PLANE_URL: url,
        ...(channel ? { CLANKIE_SEAT_PARENT_ARGV: "claude --channels plugin:clankie-worker@clankie" } : {}),
      },
    },
  );
  cleanups.push(() => child.kill());
  const notifications: unknown[] = [];
  const replies = new Map<number, unknown>();
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += String(chunk);
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n");
      const line = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (line.id !== undefined) replies.set(line.id, line);
      else if (line.method === "notifications/claude/channel") notifications.push(line);
    }
  });
  let sequence = 0;
  const call = async (method: string, params: unknown, timeoutMs = 5_000) => {
    const id = ++sequence;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (let i = 0; i < Math.ceil(timeoutMs / 25); i++) {
      if (replies.has(id)) return replies.get(id) as { result: { content: { text: string }[] } };
      if (child.exitCode !== null) throw new Error(stderr);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No response: ${stderr}`);
  };
  return {
    child,
    notifications,
    initialized: () =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`),
    stderr: () => stderr,
    init: () =>
      call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
    list: async (timeoutMs?: number) =>
      (await call("tools/list", {}, timeoutMs)) as unknown as {
        result: { tools: { name: string }[] };
      },
    message: async (text = "original") =>
      JSON.parse(
        (await call("tools/call", { name: "message_clankie", arguments: { text } })).result.content[0]!.text,
      ) as { received: boolean; deliveryStage: string; deliveryId: string },
  };
}
describe("the first native tool catalog while a pane settles (VUH-1558)", () => {
  it.each(["deny", "empty"] as const)(
    "retries a %s lookup before answering the first tools/list, then observes revocation immediately",
    async (failure) => {
      let attempts = 0;
      let revoked = false;
      const service = await fakeService(false, (method) => {
        if (revoked) return "deny";
        if (method === (failure === "deny" ? "initialize" : "tools/list") && ++attempts <= 2) return failure;
      });
      const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url);
      await bridge.init();
      expect((await bridge.list()).result.tools.map((tool) => tool.name)).toEqual([
        "message_clankie",
        "linear_get_issue",
      ]);
      expect(attempts).toBe(3);
      expect(
        service.seen.every((request) => request.authorization === undefined && request.pane === "w8:p3"),
      ).toBe(true);
      revoked = true;
      const before = service.seen.length;
      expect((await bridge.list()).result.tools.map((tool) => tool.name)).toEqual(["message_clankie"]);
      expect(service.seen.slice(before)).toHaveLength(1);
    },
  );

  it("reopens a startup session whose occupant changed, sharing one lookup across concurrent first lists", async () => {
    let initializes = 0;
    const service = await fakeService(false, (method) => {
      if (method === "initialize") initializes += 1;
      if (method === "tools/list" && initializes === 1) return "deny";
    });
    const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url);
    await bridge.init();
    const replies = await Promise.all([bridge.list(), bridge.list()]);
    for (const reply of replies)
      expect(reply.result.tools.map((tool) => tool.name)).toEqual(["message_clankie", "linear_get_issue"]);
    expect(initializes).toBe(2);
  });

  it.each(["deny", "stall"] as const)(
    "answers without granted tools within the startup budget when proof continues to %s",
    async (failure) => {
      const service = await fakeService(false, () => failure);
      const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url);
      await bridge.init();
      const started = performance.now();
      expect((await bridge.list(25_000)).result.tools.map((tool) => tool.name)).toEqual(["message_clankie"]);
      expect(performance.now() - started).toBeGreaterThanOrEqual(19_000);
      expect(performance.now() - started).toBeLessThan(25_000);
      expect(service.seen.some((request) => request.body.includes("tools/call"))).toBe(false);
    },
  );
});
it.each(["fleet", "seat"] as const)(
  "%s reconciles lost acceptance after raw bridge and service replacement, without another POST",
  async (mode) => {
    const service = await receiptService();
    const home = await linkedHome(service.url, true);
    const first = rawReceiptBridge(mode, home, service.url);
    await first.init();
    const lost = await first.message();
    expect(lost.deliveryStage).toBe("uncertain");
    first.child.kill();
    await once(first.child, "exit");
    await service.restart();
    const replacement = rawReceiptBridge(mode, home, service.url);
    await replacement.init();
    service.setDenied(true);
    expect((await replacement.message()).deliveryStage).toBe("uncertain");
    service.setDenied(false);
    expect(await replacement.message()).toMatchObject({
      received: true,
      deliveryStage: "stored",
      deliveryId: lost.deliveryId,
    });
    expect(service.seen.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(service.runner).toHaveBeenCalledTimes(1);
  },
);
it.each(["fleet", "seat"] as const)(
  "%s keeps pre-acceptance uncertainty across replacement and refuses a different payload",
  async (mode) => {
    const service = await receiptService();
    service.setPending();
    const home = await linkedHome(service.url, true);
    const first = rawReceiptBridge(mode, home, service.url);
    await first.init();
    expect((await first.message()).deliveryStage).toBe("uncertain");
    first.child.kill();
    await once(first.child, "exit");
    await service.restart();
    const replacement = rawReceiptBridge(mode, home, service.url);
    await replacement.init();
    expect((await replacement.message("replacement")).deliveryStage).toBe("uncertain");
    expect(service.seen.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(service.runner).not.toHaveBeenCalled();
  },
);
it("a legacy response without an exact receipt never clears the raw bridge's pending claim", async () => {
  const service = await receiptService();
  service.setDrop(false);
  service.setLegacyReply();
  const home = await linkedHome(service.url, true);
  const bridge = rawReceiptBridge("fleet", home, service.url);
  await bridge.init();
  expect((await bridge.message()).deliveryStage).toBe("uncertain");
  expect((await bridge.message()).deliveryStage).toBe("stored");
  expect(service.seen.filter((r) => r.method === "POST")).toHaveLength(1);
});
it("two raw bridges sharing a pane claim at most one original POST", async () => {
  const service = await receiptService();
  service.setPending();
  const home = await linkedHome(service.url, true);
  const first = rawReceiptBridge("fleet", home, service.url);
  const second = rawReceiptBridge("seat", home, service.url);
  await Promise.all([first.init(), second.init()]);
  const results = await Promise.all([first.message(), second.message()]);
  expect(results.map((r) => r.deliveryStage)).toEqual(["uncertain", "uncertain"]);
  expect(service.seen.filter((r) => r.method === "POST")).toHaveLength(1);
  expect(service.runner).not.toHaveBeenCalled();
});
it.each([false, true])(
  "installed linked channel acknowledges its exact written event and stops on lost ack=%s",
  async (dropAck) => {
    const service = await fakeService(dropAck);
    const home = await linkedHome(service.url, true);
    const bridge = rawReceiptBridge("fleet", home, service.url, true);
    await bridge.init();
    bridge.initialized();
    await expect.poll(() => service.seen.filter((r) => r.path.endsWith("/ack")).length).toBe(1);
    expect(bridge.notifications).toMatchObject([
      { params: { meta: { event_id: "event-1" }, content: "Hello from Clankie" } },
    ]);
    expect(service.seen.find((r) => r.path.endsWith("/ack"))).toMatchObject({
      method: "POST",
      path: "/v1/fleet/seats/w8%3Ap3/events/event-1/ack",
      pane: "w8:p3",
      authorization: undefined,
    });
    if (dropAck) {
      await expect.poll(() => bridge.stderr()).toContain("stopped polling without replay");
      expect(service.seen.filter((r) => r.path.endsWith("/events"))).toHaveLength(1);
      expect(bridge.notifications).toHaveLength(1);
    } else
      await expect
        .poll(() => service.seen.filter((r) => r.path.endsWith("/events")).length)
        .toBeGreaterThan(1);
  },
);

describe("a Codex session on the shared daemon", () => {
  it("tells the agent why Clankie's tools are missing and how to get them", async () => {
    const home = await linkedHome("http://127.0.0.1:1", true);
    const bridge = spawn(process.execPath, [join(bin, "fleet-mcp.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        HERDR_PANE_ID: "w8:p3",
        HERDR_SOCKET_PATH: SOCKET,
        CLANKIE_SEAT_PARENT_ARGV: "codex app-server --listen unix:// --managed-daemon",
      },
    });
    cleanups.push(() => bridge.kill());
    let stdout = "";
    bridge.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    for (let attempt = 0; attempt < 200 && !stdout.includes("\n"); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const reply = JSON.parse(stdout.split("\n")[0]!) as { result: { instructions: string } };
    expect(reply.result.instructions).toContain("codex --no-daemon");
    expect(reply.result.instructions).toContain("message_clankie");
  });
});
