import { fleetLinkFetch } from "../../clankie/src/fleet-link.ts";
import { createHash } from "node:crypto";
import { ConversationStore } from "../../clankie/src/captain/conversations.ts";
import { InboundSeatReceipts } from "../../clankie/src/captain/inbound-seat-receipts.ts";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  mcpReply?: (method: string) => "deny" | "empty" | "stall" | "off" | undefined,
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
        // The fleet two-tool catalog, as Clankie's worker endpoint answers it.
        const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
        const reply = mcpReply?.(message.method);
        if (reply === "deny") {
          response.statusCode = 403;
          response.end(
            JSON.stringify({ error: "fleet_admission_pending", detail: "process proof is settling" }),
          );
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
                    reply === "empty" || reply === "off"
                      ? []
                      : ["clankie_tools", "clankie_call"].map((name) => ({
                          name,
                          inputSchema: { type: "object" },
                        })),
                  ...(reply === "empty"
                    ? {}
                    : { _meta: { clankie: { tools: reply === "off" ? "off" : "connected" } } }),
                }
              : { content: [{ type: "text", text: `ran ${String(message.params?.name)}` }], isError: false };
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        return;
      }
      if (path.endsWith("/peers")) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: "peer_messages_disabled" }));
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
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
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

describe("worker discovery in a private service's state root (VUH-1631)", () => {
  it.each([true, false])(
    "never falls back to the shared descriptor (private link present=%s)",
    async (present) => {
      const home = await linkedHome("http://127.0.0.1:54321", true);
      const privateRoot = join(home, "private-state");
      try {
        if (present) {
          await mkdir(join(privateRoot, "links"), { recursive: true });
          await writeFile(
            join(privateRoot, "links", "default-local.json"),
            JSON.stringify({
              schemaVersion: 2,
              authentication: "local-process",
              fleet: "default",
              socket: SOCKET,
              url: "http://127.0.0.1:54322",
            }),
          );
        }
        const output = execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { readLink, hasLinks } from ${JSON.stringify(pathToFileURL(join(bin, "link.mjs")).href)}; console.log(JSON.stringify({link: readLink(), linked: hasLinks()}));`,
          ],
          {
            encoding: "utf8",
            env: { HOME: home, HERDR_SOCKET_PATH: SOCKET, CLANKIE_STATE: ` ${privateRoot} ` },
          },
        );
        expect(JSON.parse(output)).toEqual(
          present
            ? {
                link: {
                  schemaVersion: 2,
                  authentication: "local-process",
                  fleet: "default",
                  socket: SOCKET,
                  url: "http://127.0.0.1:54322",
                },
                linked: true,
              }
            : { linked: false },
        );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("treats whitespace state as the default home state", async () => {
    const home = await linkedHome("http://127.0.0.1:54321", true);
    try {
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { readLink, hasLinks } from ${JSON.stringify(pathToFileURL(join(bin, "link.mjs")).href)}; console.log(JSON.stringify({url: readLink()?.url, linked: hasLinks()}));`,
        ],
        { encoding: "utf8", env: { HOME: home, HERDR_SOCKET_PATH: SOCKET, CLANKIE_STATE: "  " } },
      );
      expect(JSON.parse(output)).toEqual({ url: "http://127.0.0.1:54321", linked: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("forwards the service state to the Codex MCP bridge", async () => {
    const config = JSON.parse(await readFile(join(bin, "..", "codex-mcp.json"), "utf8"));
    expect(config.mcpServers.clankie.env_vars).toContain("CLANKIE_STATE");
  });
});

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
      result: { tools: [{ name: "message_clankie" }, { name: "clankie_tools" }, { name: "clankie_call" }] },
    });
    // A meta call is proxied to Clankie's service over the link.
    write({
      id: 4,
      method: "tools/call",
      params: { name: "clankie_call", arguments: { name: "linear_get_issue", arguments: { id: "A-1" } } },
    });
    expect(await waitFor((line) => line.id === 4)).toMatchObject({
      result: { isError: false, content: [{ text: "ran clankie_call" }] },
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
    await vi.waitFor(() => expect(stderr).toContain("not polling"), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
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
    write({
      id: 2,
      method: "tools/call",
      params: { name: "clankie_call", arguments: { name: "linear_get_issue", arguments: { id: "A-1" } } },
    });
    expect(await waitFor(2)).toMatchObject({
      result: { isError: false, content: [{ text: "ran clankie_call" }] },
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
  let denyPostReply = false;
  let legacyReply = false;
  let refusePost = false;
  let stopped: Promise<void> | undefined;
  let redirect = false;
  const redirects: string[] = [];
  let dropBeforeAdmission = false;
  let mismatchLookup = false;
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
      if (url.pathname === "/redirected-message") {
        redirects.push(raw);
        response.destroy();
        return;
      }
      if (request.method === "GET" && url.pathname.endsWith("/messages")) {
        if (refusePost) response.setHeader("connection", "close");
        response.end(JSON.stringify({ schemaVersion: 1, binding: "a".repeat(64) }));
        if (refusePost) {
          refusePost = false;
          stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        }
        return;
      }
      if (request.method === "GET") {
        if (denyLookup) {
          response.statusCode = 403;
          response.end(
            JSON.stringify({
              schemaVersion: 1,
              received: false,
              deliveryStage: "unavailable",
              definitive: "not_sent",
              deliveryId: url.pathname.split("/").at(-1),
              binding: url.searchParams.get("binding"),
              fingerprint: url.searchParams.get("fingerprint"),
            }),
          );
          return;
        }
        const receipt = receipts.lookup(
          "w8:p3",
          { id: url.pathname.split("/").at(-1)!, binding: url.searchParams.get("binding")! },
          url.searchParams.get("fingerprint")!,
        );
        response.end(JSON.stringify({ ...receipt, ...(mismatchLookup ? { binding: "b".repeat(64) } : {}) }));
        return;
      }
      const input = JSON.parse(raw);
      if (dropBeforeAdmission) {
        dropBeforeAdmission = false;
        response.destroy();
        return;
      }
      if (beforeAcceptance)
        vi.spyOn(store, "submitInbound").mockImplementationOnce(() => {
          throw new Error("crash before acceptance");
        });
      const receipt = receipts.accept("w8:p3", input.delivery, input.text, `Agent output: ${input.text}`);
      if (denyPostReply) {
        response.statusCode = 403;
        response.end(JSON.stringify({ ...receipt, received: false, deliveryStage: "unavailable" }));
        return;
      }
      if (redirect) {
        response.writeHead(307, { location: "/redirected-message" });
        response.end();
        return;
      }
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
    redirects,
    setDrop: (value: boolean) => {
      drop = value;
    },
    setRedirect: () => {
      redirect = true;
    },
    dropBeforeAdmission: () => {
      dropBeforeAdmission = true;
    },
    mismatchLookup: (value: boolean) => {
      mismatchLookup = value;
    },
    setPending: (value = true) => {
      beforeAcceptance = value;
    },
    setDenied: (value: boolean) => {
      denyLookup = value;
    },
    setDeniedPostReply: () => {
      denyPostReply = true;
    },
    setLegacyReply: () => {
      legacyReply = true;
    },
    refuseNextPost: () => {
      refusePost = true;
    },
    reopen: async () => {
      await stopped;
      await new Promise<void>((resolve) => server.listen(address.port, "127.0.0.1", resolve));
    },
    restart: async () => {
      await store.close();
      store = new ConversationStore(join(root, "conversations"), runner);
      receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
    },
  };
}
function rawReceiptBridge(
  mode: "fleet" | "seat",
  home: string,
  url: string,
  channel = false,
  requestTimeoutMs?: number,
  expectedToolNames?: string,
) {
  const code = `import { runMcpCommand } from ${JSON.stringify(new URL("../src/command/mcp.ts", import.meta.url).href)}; await runMcpCommand(["--seat"], { readParentArgv: async () => "test" });`;
  const parentArgv = channel ? "claude --channels plugin:clankie-worker@clankie" : "test";
  const fleetCode = `import {runSeatChannel} from ${JSON.stringify(pathToFileURL(join(bin, "seat-channel.mjs")).href)};runSeatChannel({paneId:"w8:p3",parentArgv:${JSON.stringify(parentArgv)},requestTimeoutMs:${String(requestTimeoutMs)}});`;
  const child = spawn(
    process.execPath,
    mode === "fleet"
      ? requestTimeoutMs === undefined
        ? [join(bin, "fleet-mcp.mjs")]
        : ["--input-type=module", "-e", fleetCode]
      : ["--input-type=module", "-e", code],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        HERDR_PANE_ID: "w8:p3",
        HERDR_SOCKET_PATH: SOCKET,
        CLANKIE_OPERATOR_TOKEN: "test-only",
        CLANKIE_CONTROL_PLANE_URL: url,
        ...(expectedToolNames === undefined ? {} : { CLANKIE_EXPECTED_TOOL_NAMES: expectedToolNames }),
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
      if (replies.has(id))
        return replies.get(id) as {
          result: { content: { text: string }[]; isError?: boolean };
          error?: { code: number; message: string };
        };
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
    // Wait for the actual reply within the first discovery's production budget.
    list: async (timeoutMs?: number) =>
      (await call(
        "tools/list",
        {},
        timeoutMs ?? Math.min(requestTimeoutMs ?? 20_000, 20_000) + 2_000,
      )) as unknown as {
        result: { tools: { name: string }[] };
        error?: { code: number; message: string };
      },
    tool: (name: string, args: unknown = {}, meta?: unknown) =>
      call("tools/call", { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) }),
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
        if (revoked && method === "tools/list") return "off";
        if (method === (failure === "deny" ? "initialize" : "tools/list") && ++attempts <= 2) return failure;
      });
      const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url);
      await bridge.init();
      expect((await bridge.list()).result.tools.map((tool) => tool.name)).toEqual([
        "message_clankie",
        "clankie_tools",
        "clankie_call",
      ]);
      expect(attempts).toBe(3);
      expect(
        service.seen.every((request) => request.authorization === undefined && request.pane === "w8:p3"),
      ).toBe(true);
      revoked = true;
      const before = service.seen.length;
      expect((await bridge.list()).result.tools.map((tool) => tool.name)).toEqual(["message_clankie"]);
      expect(
        service.seen
          .slice(before)
          .filter((entry) => !entry.body.includes("notifications/clankie/bridge_status"))
          .map((request) => request.path)
          .sort(),
      ).toEqual(["/v1/fleet/mcp", "/v1/fleet/seats/w8%3Ap3/peers"]);
    },
  );

  it("reopens a refused startup session, sharing one lookup across concurrent first lists", async () => {
    let initializes = 0;
    const service = await fakeService(false, (method) => {
      if (method === "initialize") initializes += 1;
      if (method === "tools/list" && initializes === 1) return "deny";
    });
    const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url);
    await bridge.init();
    const replies = await Promise.all([bridge.list(), bridge.list()]);
    for (const reply of replies)
      expect(reply.result.tools.map((tool) => tool.name)).toEqual([
        "message_clankie",
        "clankie_tools",
        "clankie_call",
      ]);
    expect(initializes).toBe(2);
  });

  it.each(["deny", "stall"] as const)(
    "fails with the real reason within the startup budget when proof continues to %s",
    async (failure) => {
      const service = await fakeService(false, () => failure);
      const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url, false, 400);
      await bridge.init();
      const started = performance.now();
      const reply = await bridge.list(2_000);
      expect(reply.error?.message).toContain("initial tool catalog is unavailable");
      expect(reply.error?.message).toContain(
        failure === "deny" ? "403: fleet_admission_pending" : "timed out",
      );
      expect(reply).not.toHaveProperty("result");
      expect(performance.now() - started).toBeGreaterThanOrEqual(350);
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(service.seen.some((request) => request.body.includes("tools/call"))).toBe(false);
    },
  );
});
it.each(["fleet", "seat"] as const)(
  "%s settles a refused POST claim so a later invocation can send a new message once",
  async (mode) => {
    const service = await receiptService();
    service.refuseNextPost();
    const bridge = rawReceiptBridge(mode, await linkedHome(service.url, true), service.url);
    await bridge.init();
    const refused = await bridge.message("not dispatched");
    expect(refused.deliveryStage).toBe("unavailable");
    expect(service.seen.filter((entry) => entry.method === "POST")).toEqual([]);
    await service.reopen();
    service.setDrop(false);
    const next = await bridge.message("new message");
    expect(next).toMatchObject({ received: true, deliveryStage: "stored" });
    expect(next.deliveryId).not.toBe(refused.deliveryId);
    const posts = service.seen.filter((entry) => entry.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body).text).toBe("new message");
  },
);

it("settles only an authenticated exact terminal unknown receipt and sends no replacement in that invocation", async () => {
  const service = await receiptService();
  service.setDrop(false);
  service.dropBeforeAdmission();
  const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url);
  await bridge.init();
  const original = await bridge.message("never admitted");
  expect(original.deliveryStage).toBe("uncertain");
  service.setDenied(true);
  expect((await bridge.message("replacement")).deliveryStage).toBe("uncertain");
  service.setDenied(false);
  service.mismatchLookup(true);
  expect((await bridge.message("replacement")).deliveryStage).toBe("uncertain");
  service.mismatchLookup(false);
  expect(await bridge.message("replacement")).toMatchObject({
    received: false,
    deliveryStage: "unavailable",
    deliveryId: original.deliveryId,
  });
  const originals = service.seen.filter((entry) => entry.method === "POST");
  expect(originals).toHaveLength(1);
  expect(service.runner).not.toHaveBeenCalled();
  // A service terminal negative must also reject a late original, rather than
  // allowing acceptance after the client has released its local claim.
  const late = await fetch(`${service.url}/v1/fleet/seats/w8%3Ap3/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: originals[0]!.body,
  });
  expect(await late.json()).toMatchObject({
    received: false,
    definitive: "not_sent",
    deliveryId: original.deliveryId,
  });
  expect(service.runner).not.toHaveBeenCalled();
  const next = await bridge.message("new original");
  expect(next).toMatchObject({ received: true, deliveryStage: "stored" });
  expect(next.deliveryId).not.toBe(original.deliveryId);
  expect(service.runner).toHaveBeenCalledOnce();
  expect(service.seen.filter((entry) => entry.method === "POST")).toHaveLength(3);
});

it("retains an accepted redirect receipt without letting fetch send another POST", async () => {
  const service = await receiptService();
  service.setRedirect();
  const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url);
  await bridge.init();
  const original = await bridge.message();
  expect(original.deliveryStage).toBe("uncertain");
  expect(await bridge.message()).toMatchObject({
    received: true,
    deliveryStage: "stored",
    deliveryId: original.deliveryId,
  });
  expect(service.redirects).toEqual([]);
  expect(service.seen.filter((entry) => entry.method === "POST")).toHaveLength(1);
  expect(service.runner).toHaveBeenCalledOnce();
});

it("keeps an original claim when HTTP403 carries an exact-looking refusal body", async () => {
  const service = await receiptService();
  service.setDrop(false);
  service.setDeniedPostReply();
  const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url);
  await bridge.init();
  const original = await bridge.message();
  expect(original.deliveryStage).toBe("uncertain");
  expect(await bridge.message()).toMatchObject({
    received: true,
    deliveryStage: "stored",
    deliveryId: original.deliveryId,
  });
  expect(service.seen.filter((entry) => entry.method === "POST")).toHaveLength(1);
  expect(service.runner).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "handles a real AggregateError cause chain without clearing a lost accepted reply=%s",
  async (accepted) => {
    const service = await receiptService();
    service.setDrop(accepted);
    const home = await linkedHome(service.url, true);
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const address = closed.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `
    import {createInboundSender} from ${JSON.stringify(pathToFileURL(join(bin, "inbound-receipt.mjs")).href)};
    import {createConnection} from 'node:net';
    import {createInterface} from 'node:readline';
    const endpoint=${JSON.stringify(`${service.url}/v1/fleet/seats/w8%3Ap3/messages`)};
    let refuse=true;
    const send=createInboundSender({directory:${JSON.stringify(join(home, ".clankie", "inbound-receipts"))},scope:'aggregate-fixture',request:async(suffix,init)=>{
      if(init?.method==='POST' && refuse){
        refuse=false;
        let refused;
        try {
          await new Promise((resolve,reject)=>{
            const socket=createConnection({host:'fixture',port:${address.port},autoSelectFamily:true,lookup:(_host,_options,callback)=>callback(null,[{address:'::1',family:6},{address:'127.0.0.1',family:4}])});
            socket.on('error',reject).on('connect',()=>{socket.destroy();resolve();});
          });
        } catch(error) {
          process.stderr.write(JSON.stringify({name:error.name,codes:error.errors?.map((entry)=>entry.code)})+'\\n');
          refused=error;
        }
        if(${accepted}) {
          let lost;
          try { await fetch(endpoint+suffix,init); } catch(error) { lost=error; }
          throw new TypeError('fetch failed',{cause:new AggregateError([refused,lost],'refused and lost reply')});
        }
        throw new TypeError('fetch failed',{cause:refused});
      }
      return fetch(endpoint+suffix,init);
    }});
    for await(const line of createInterface({input:process.stdin})) process.stdout.write(JSON.stringify(await send(JSON.parse(line).text))+'\\n');
  `,
    ]);
    cleanups.push(() => child.kill());
    const replies: { received: boolean; deliveryStage: string }[] = [];
    let buffered = "";
    let stderr = "";
    child.stderr.on("data", (bytes: Buffer) => {
      stderr += String(bytes);
    });
    child.stdout.on("data", (bytes: Buffer) => {
      buffered += String(bytes);
      while (buffered.includes("\n")) {
        const at = buffered.indexOf("\n");
        replies.push(JSON.parse(buffered.slice(0, at)));
        buffered = buffered.slice(at + 1);
      }
    });
    child.stdin.write(`${JSON.stringify({ text: "refused original" })}\n`);
    await expect.poll(() => replies.length, { timeout: 5_000 }).toBe(1);
    expect(JSON.parse(stderr.trim())).toEqual({
      name: "AggregateError",
      codes: ["ECONNREFUSED", "ECONNREFUSED"],
    });
    expect(replies[0]).toMatchObject({
      received: false,
      deliveryStage: accepted ? "uncertain" : "unavailable",
    });
    expect(service.seen.filter((entry) => entry.method === "POST")).toHaveLength(accepted ? 1 : 0);
    child.stdin.write(`${JSON.stringify({ text: accepted ? "refused original" : "new original" })}\n`);
    await expect.poll(() => replies.length, { timeout: 5_000 }).toBe(2);
    expect(replies[1]).toMatchObject({ received: true, deliveryStage: "stored" });
    expect(service.seen.filter((entry) => entry.method === "POST")).toHaveLength(1);
  },
);

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
  "%s seals a pre-acceptance original after replacement without POSTing until a deliberate fresh invocation",
  async (mode) => {
    const service = await receiptService();
    service.setPending();
    const home = await linkedHome(service.url, true);
    const first = rawReceiptBridge(mode, home, service.url);
    await first.init();
    const lost = (await first.message()) as {
      received: boolean;
      deliveryStage: string;
      deliveryId: string;
      binding: string;
      fingerprint: string;
    };
    expect(lost).toMatchObject({
      received: false,
      deliveryStage: "uncertain",
      binding: "a".repeat(64),
      fingerprint: createHash("sha256").update("original").digest("hex"),
    });
    first.child.kill();
    await once(first.child, "exit");
    await service.restart();
    const replacement = rawReceiptBridge(mode, home, service.url);
    await replacement.init();
    expect(await replacement.message("replacement")).toMatchObject({
      received: false,
      deliveryStage: "unavailable",
      definitive: "not_sent",
      deliveryId: lost.deliveryId,
      binding: lost.binding,
      fingerprint: lost.fingerprint,
    });
    expect(service.seen.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(service.runner).not.toHaveBeenCalled();
    service.setPending(false);
    service.setDrop(false);
    const fresh = await replacement.message("deliberate fresh report");
    expect(fresh).toMatchObject({ received: true, deliveryStage: "stored" });
    expect(fresh.deliveryId).not.toBe(lost.deliveryId);
    expect(service.seen.filter((r) => r.method === "POST")).toHaveLength(2);
    expect(service.runner).toHaveBeenCalledTimes(1);
    expect(service.runner).toHaveBeenCalledWith(
      "global-default",
      "Agent output: deliberate fresh report",
      expect.any(Function),
      expect.any(Object),
    );
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

/** Real HTTP peer/MCP frames with independently identified sessions and controlled wire failures. */
async function recoveryService(
  options: {
    holdInitialized?: boolean;
    holdCatalog?: boolean;
    peerMessages?: "on" | "off";
    nativePeerProofRequired?: boolean;
    connectedCallReceipts?: boolean;
    loseConnectedReply?: boolean;
    hangConnectedReply?: boolean;
    redirectConnectedReply?: boolean;
  } = {},
) {
  let initializes = 0;
  let discoveryFails = false;
  let peersFail = false;
  let peersOff = false;
  let peerRequests = 0;
  let mailboxRequests = 0;
  let peerMessages = options.peerMessages;
  let toolRefusal: { status: number; error: string; reason: string } | undefined;
  let peerRefusal: { status: number; error: string; reason: string } | undefined;
  let connectedReceipt: string | undefined;
  const connectedMetadata: (string | undefined)[] = [];
  let connectedDispatches = 0;
  let connectedRedirects = 0;
  let connectedSettled = false;
  const connectedSchema = {
    type: "object",
    anyOf: [
      {
        type: "object",
        properties: { name: { type: "string" }, arguments: { type: "object" } },
        required: ["name", "arguments"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { receiptId: { type: "string", format: "uuid" } },
        required: ["receiptId"],
        additionalProperties: false,
      },
    ],
  };
  let prematureCall = false;
  let releaseHandshake: () => void = () => {};
  const handshake = options.holdInitialized
    ? new Promise<void>((resolve) => {
        releaseHandshake = resolve;
      })
    : Promise.resolve();
  const initialized = new Set<string>();
  let releaseCatalog: () => void = () => {};
  const catalog = options.holdCatalog
    ? new Promise<void>((resolve) => {
        releaseCatalog = resolve;
      })
    : Promise.resolve();
  const calls: string[] = [];
  const bridgeRequests: { method: string; bridgeId: string; session: string }[] = [];
  const health: { status: string; reason: string; tools: string[] }[] = [];
  let mutationResponse: ServerResponse | undefined;
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (bytes) => {
      text += String(bytes);
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/redirected-connected") {
        connectedRedirects++;
        response.destroy();
        return;
      }
      if (request.url?.includes("/events?")) {
        mailboxRequests++;
        setTimeout(() => response.end(JSON.stringify({ schemaVersion: 1, events: [] })), 200);
        return;
      }
      if (request.url?.endsWith("/peers")) {
        peerRequests++;
        if (peerRefusal) {
          response.statusCode = peerRefusal.status;
          response.end(JSON.stringify(peerRefusal));
        } else if (options.nativePeerProofRequired) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: "native_peer_sender_required" }));
        } else if (peersOff || peersFail) {
          response.statusCode = peersOff ? 403 : 503;
          response.end(
            JSON.stringify({ error: peersOff ? "peer_messages_disabled" : "peer_observation_failed" }),
          );
        } else
          response.end(
            JSON.stringify({
              schemaVersion: 1,
              fleet: "default",
              sender: { seatId: "sender", paneId: "w8:p3", binding: "a".repeat(64) },
              seats: [],
            }),
          );
        return;
      }
      const rpc = JSON.parse(text) as {
        id?: number;
        method: string;
        params?: {
          name?: string;
          arguments?: { receiptId?: string };
          _meta?: { clankieReceiptId?: string };
        };
      };
      bridgeRequests.push({
        method: rpc.method,
        bridgeId: String(request.headers["x-clankie-bridge-id"] ?? ""),
        session: String(request.headers["mcp-session-id"] ?? ""),
      });
      const reply = (result: unknown) => response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      if (rpc.method === "initialize") {
        response.setHeader("mcp-session-id", `session-${++initializes}`);
        reply({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        });
        return;
      }
      const session = String(request.headers["mcp-session-id"] ?? "");
      if (rpc.method === "notifications/initialized") {
        void handshake.then(() => {
          initialized.add(session);
          response.statusCode = 202;
          response.end();
        });
        return;
      }
      if (rpc.method === "notifications/clankie/bridge_status") {
        health.push(rpc.params as unknown as { status: string; reason: string; tools: string[] });
        response.statusCode = 202;
        response.end();
        return;
      }
      if (!initialized.has(session)) prematureCall = true;
      if (rpc.method === "tools/list") {
        if (toolRefusal) {
          response.statusCode = toolRefusal.status;
          response.end(JSON.stringify(toolRefusal));
        } else if (discoveryFails) {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: "catalog_observation_failed" }));
        } else
          void catalog.then(() =>
            reply({
              tools: ["clankie_tools", "clankie_call"].map((name) => ({
                name,
                inputSchema:
                  name === "clankie_call" && options.connectedCallReceipts
                    ? connectedSchema
                    : { type: "object" },
                ...(name === "clankie_call" && options.connectedCallReceipts
                  ? {
                      description:
                        "Reconcile an uncertain result with receiptId only; never retry name/arguments.",
                    }
                  : {}),
              })),
              _meta: { clankie: { tools: "connected", ...(peerMessages ? { peerMessages } : {}) } },
            }),
          );
        return;
      }
      const name = rpc.params?.name ?? "";
      calls.push(name);
      if (toolRefusal) {
        response.statusCode = toolRefusal.status;
        response.end(JSON.stringify(toolRefusal));
        return;
      }
      if (name === "clankie_call" && options.connectedCallReceipts) {
        connectedMetadata.push(rpc.params?._meta?.clankieReceiptId);
        if (rpc.params?.arguments?.receiptId === undefined) {
          connectedReceipt = rpc.params?._meta?.clankieReceiptId;
          connectedDispatches++;
          if (options.redirectConnectedReply) {
            response.writeHead(307, { location: "/redirected-connected" });
            response.end();
            return;
          }
          if (options.loseConnectedReply) {
            response.destroy();
            return;
          }
          if (options.hangConnectedReply) {
            response.writeHead(200);
            response.write(`{"jsonrpc":"2.0","id":${String(rpc.id)},"result":`);
            return;
          }
        }
        const result = connectedSettled
          ? { outcome: "ok", receiptId: connectedReceipt, content: "update completed", isError: false }
          : {
              outcome: "uncertain",
              receiptId: connectedReceipt,
              detail: "may have applied; reconcile, don’t retry",
            };
        reply({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
        return;
      }
      if (name === "mutate") {
        mutationResponse = response;
        return;
      }
      if (name === "hang") {
        response.writeHead(200);
        response.write(`{"jsonrpc":"2.0","id":${String(rpc.id)},"result":`);
        return;
      }
      reply({ content: [{ type: "text", text: "read completed" }], isError: false });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    calls,
    bridgeRequests,
    health,
    connectedSchema,
    connectedMetadata,
    connectedDispatches: () => connectedDispatches,
    connectedRedirects: () => connectedRedirects,
    settleConnectedCall: () => {
      connectedSettled = true;
    },
    initializes: () => initializes,
    peerRequests: () => peerRequests,
    mailboxRequests: () => mailboxRequests,
    setPeerMessages: (value: "on" | "off") => {
      peerMessages = value;
    },
    refuseTools: (value: typeof toolRefusal) => {
      toolRefusal = value;
    },
    refusePeers: (value: typeof peerRefusal) => {
      peerRefusal = value;
    },
    prematureCall: () => prematureCall,
    releaseHandshake,
    releaseCatalog,
    failDiscovery: (value: boolean) => {
      discoveryFails = value;
    },
    failPeers: (value: boolean) => {
      peersFail = value;
    },
    disablePeers: () => {
      peersOff = true;
    },
    loseMutationReply: () => mutationResponse?.destroy(),
  };
}

it("preserves a connected-call uncertain receipt and advertises read-only receipt reconciliation", async () => {
  const service = await recoveryService({ peerMessages: "on", connectedCallReceipts: true });
  const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url, false, 1_000);
  await bridge.init();
  const listed = (await bridge.list()).result.tools as {
    name: string;
    description?: string;
    inputSchema: unknown;
  }[];
  const tool = listed.find((entry) => entry.name === "clankie_call");
  expect(tool?.inputSchema).toEqual(service.connectedSchema);
  expect(tool?.description).toContain("never retry name/arguments");
  const original = await bridge.tool("clankie_call", {
    name: "linear_update_issue",
    arguments: { id: "VUH-1677" },
  });
  expect(original.result.isError).toBe(false);
  const uncertain = JSON.parse(original.result.content[0]!.text);
  expect(uncertain).toMatchObject({
    outcome: "uncertain",
    receiptId: expect.stringMatching(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u),
    detail: "may have applied; reconcile, don’t retry",
  });
  expect(service.connectedMetadata).toEqual([uncertain.receiptId]);
  expect(service.connectedDispatches()).toBe(1);
  service.settleConnectedCall();
  const reconciled = await bridge.tool("clankie_call", { receiptId: uncertain.receiptId });
  expect(JSON.parse(reconciled.result.content[0]!.text)).toEqual({
    outcome: "ok",
    receiptId: uncertain.receiptId,
    content: "update completed",
    isError: false,
  });
  expect(service.connectedDispatches()).toBe(1);
  expect(service.connectedMetadata).toEqual([uncertain.receiptId, undefined]);
  expect(service.calls).toEqual(["clankie_call", "clankie_call"]);
});

it.each(["lost", "body timeout", "redirect"] as const)(
  "retains its own receipt ID after a connected-call %s, ignoring caller metadata",
  async (failure) => {
    const service = await recoveryService({
      peerMessages: "on",
      connectedCallReceipts: true,
      loseConnectedReply: failure === "lost",
      hangConnectedReply: failure === "body timeout",
      redirectConnectedReply: failure === "redirect",
    });
    const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url, false, 500);
    await bridge.init();
    await bridge.list();
    const callerId = "a9e2fb38-d24a-4ec6-b89a-d8f095b7abc1";
    const lost = await bridge.tool(
      "clankie_call",
      { name: "linear_update_issue", arguments: { id: "VUH-1677" } },
      { clankieReceiptId: callerId },
    );
    expect(lost.result.isError).toBe(false);
    const uncertain = JSON.parse(lost.result.content[0]!.text);
    expect(uncertain).toEqual({
      outcome: "uncertain",
      receiptId: expect.stringMatching(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u),
      detail: "may have applied; reconcile, don’t retry",
      reason: expect.stringContaining(
        failure === "body timeout" ? "timed out within its 500 ms" : "fetch failed",
      ),
    });
    expect(uncertain.receiptId).not.toBe(callerId);
    expect(service.connectedMetadata).toEqual([uncertain.receiptId]);
    expect(service.connectedDispatches()).toBe(1);
    expect(service.connectedRedirects()).toBe(0);
    expect(service.calls).toEqual(["clankie_call"]);
    service.settleConnectedCall();
    const reconciled = await bridge.tool("clankie_call", { receiptId: uncertain.receiptId });
    expect(JSON.parse(reconciled.result.content[0]!.text)).toEqual({
      outcome: "ok",
      receiptId: uncertain.receiptId,
      content: "update completed",
      isError: false,
    });
    expect(service.connectedMetadata).toEqual([uncertain.receiptId, undefined]);
    expect(service.connectedDispatches()).toBe(1);
    expect(service.calls).toEqual(["clankie_call", "clankie_call"]);
  },
);

it("returns a connected-call auth refusal with its real reason and no replay", async () => {
  const service = await recoveryService({ peerMessages: "on", connectedCallReceipts: true });
  const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url, false, 500);
  await bridge.init();
  await bridge.list();
  service.refuseTools({
    status: 403,
    error: "worker_grant_unavailable",
    reason: "The admitted seat has no current native binding",
  });
  const refused = await bridge.tool("clankie_call", {
    name: "linear_update_issue",
    arguments: { id: "VUH-1677" },
  });
  expect(JSON.parse(refused.result.content[0]!.text)).toEqual({
    outcome: "refused",
    reason:
      "Fleet tools answered 403: The admitted seat has no current native binding: worker_grant_unavailable",
    detail: "The service refused current access. Nothing was resubmitted.",
  });
  expect(refused.result.isError).toBe(true);
  expect(service.connectedDispatches()).toBe(0);
  expect(service.calls).toEqual(["clankie_call"]);
});

it.each([
  { status: 403, error: "worker_grant_unavailable", reason: "Local fleet membership unavailable" },
  {
    status: 504,
    error: "worker_request_failed",
    reason: "Worker request body timed out or was cancelled: worker deadline expired",
  },
])(
  "surfaces the real $status reason without withdrawing verified tools or replaying a call",
  async (refusal) => {
    const service = await recoveryService({ peerMessages: "on" });
    const home = await linkedHome(service.url, true);
    const bridge = rawReceiptBridge("fleet", home, service.url, false, 1_000);
    await bridge.init();
    const names = ["message_clankie", "clankie_tools", "clankie_call", "list_fleet_seats", "message_peer"];
    expect((await bridge.list()).result.tools.map((tool) => tool.name)).toEqual(names);
    service.refuseTools(refusal);
    service.refusePeers({
      status: 403,
      error: "native_peer_sender_required",
      reason: "The admitted seat has no current native binding",
    });
    const denied = await bridge.tool("clankie_tools", { query: "Linear" });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]?.text).toContain(
      `${refusal.status}: ${refusal.reason}: ${refusal.error}`,
    );
    expect(service.calls).toEqual(["clankie_tools"]);
    expect((await bridge.list()).result.tools.map((tool) => tool.name)).toEqual(names);
    await expect
      .poll(() =>
        service.health.some((entry) => entry.reason.includes(`${refusal.reason}: ${refusal.error}`)),
      )
      .toBe(true);
    const peers = await bridge.tool("list_fleet_seats");
    expect(peers.error?.message).toContain(
      "The admitted seat has no current native binding: native_peer_sender_required",
    );
    const unproved = rawReceiptBridge("fleet", home, service.url, false, 1_000);
    await unproved.init();
    const initial = await unproved.list();
    expect(initial.error?.message).toContain(`${refusal.reason}: ${refusal.error}`);
    expect(initial).not.toHaveProperty("result");
    expect(service.calls).toEqual(["clankie_tools"]);
  },
);

it.each(["held", "refused"] as const)(
  "holds a hired Claude mailbox until its %s expected catalog is verified",
  async (state) => {
    const service = await recoveryService({ peerMessages: "on", holdCatalog: state === "held" });
    service.failDiscovery(state === "refused");
    const names = ["message_clankie", "clankie_tools", "clankie_call", "list_fleet_seats", "message_peer"];
    const bridge = rawReceiptBridge(
      "fleet",
      await linkedHome(service.url, true),
      service.url,
      true,
      1_000,
      JSON.stringify(names),
    );
    await bridge.init();
    bridge.initialized();
    await expect.poll(() => service.bridgeRequests.some((entry) => entry.method === "tools/list")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.mailboxRequests()).toBe(0);
    // The native list and the background readiness read share the same lookup.
    const nativeList = state === "held" ? bridge.list() : undefined;
    service.releaseCatalog();
    service.failDiscovery(false);
    await expect.poll(service.mailboxRequests).toBeGreaterThan(0);
    expect((await (nativeList ?? bridge.list())).result.tools.map((tool) => tool.name)).toEqual(names);
  },
);

it("never starts a hired Claude mailbox from a malformed catalog expectation", async () => {
  const service = await recoveryService({ peerMessages: "on" });
  const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url, true, 500, "{");
  await bridge.init();
  bridge.initialized();
  expect((await bridge.list()).error?.message).toContain("Invalid Clankie tool catalog expectation");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(service.mailboxRequests()).toBe(0);
  expect(service.bridgeRequests).toEqual([]);
});

it("identifies each bridge process across HTTP session reconnects", async () => {
  const service = await recoveryService({ peerMessages: "on" });
  const home = await linkedHome(service.url, true);
  const first = rawReceiptBridge("fleet", home, service.url, false, 1_000);
  await first.init();
  await first.list();
  const firstId = service.bridgeRequests[0]?.bridgeId;
  service.failDiscovery(true);
  await first.list();
  service.failDiscovery(false);
  await first.tool("read");
  expect(service.initializes()).toBe(2);
  const second = rawReceiptBridge("fleet", home, service.url, false, 1_000);
  await second.init();
  await second.list();
  await expect
    .poll(
      () =>
        new Set(
          service.bridgeRequests
            .filter((entry) => entry.method === "notifications/clankie/bridge_status")
            .map((entry) => entry.bridgeId),
        ).size,
    )
    .toBe(2);
  const ids = new Set(service.bridgeRequests.map((entry) => entry.bridgeId));
  expect(ids.size).toBe(2);
  for (const id of ids)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(
    service.bridgeRequests.filter((entry) => entry.bridgeId === firstId && entry.method === "initialize"),
  ).toHaveLength(2);
  expect(
    new Set(
      service.bridgeRequests
        .filter((entry) => entry.bridgeId === firstId && entry.session)
        .map((entry) => entry.session),
    ).size,
  ).toBe(2);
  expect(new Set(service.bridgeRequests.map((entry) => entry.method))).toEqual(
    new Set([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "notifications/clankie/bridge_status",
    ]),
  );
});

it("shares the whole initialized handshake and bounds a hanging response body, including initialization time", async () => {
  const service = await recoveryService({ holdInitialized: true });
  const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url, false, 500);
  await bridge.init();
  bridge.initialized();
  const started = performance.now();
  const hung = bridge.tool("hang");
  const listed = bridge.list();
  await expect.poll(service.initializes).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(service.calls).toEqual([]);
  service.releaseHandshake();
  expect((await listed).result.tools.map((tool) => tool.name)).toEqual([
    "message_clankie",
    "clankie_tools",
    "clankie_call",
    "list_fleet_seats",
    "message_peer",
  ]);
  const result = await hung;
  expect(result.result.isError).toBe(true);
  expect(result.result.content[0]?.text).toContain("timed out within its 500 ms request budget");
  expect(performance.now() - started).toBeGreaterThanOrEqual(450);
  expect(performance.now() - started).toBeLessThan(1_200);
  expect(service.initializes()).toBe(1);
  expect(service.prematureCall()).toBe(false);
  expect(service.calls).toEqual(["hang"]);
  await expect.poll(() => service.health.some((entry) => entry.status === "stalled")).toBe(true);
  expect((await bridge.tool("read")).result.content[0]?.text).toBe("read completed");
  await expect.poll(() => service.health.at(-1)?.status).toBe("ready");
});

it("retains proven catalogs while discovery fails, and never replays an admitted mutation after its result is lost", async () => {
  const service = await recoveryService();
  const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url, false, 1_000);
  await bridge.init();
  const names = ["message_clankie", "clankie_tools", "clankie_call", "list_fleet_seats", "message_peer"];
  expect((await bridge.list()).result.tools.map((tool) => tool.name)).toEqual(names);
  const mutated = bridge.tool("mutate");
  await expect.poll(() => service.calls).toEqual(["mutate"]);
  service.failDiscovery(true);
  service.failPeers(true);
  expect((await bridge.list()).result.tools.map((tool) => tool.name)).toEqual(names);
  await expect
    .poll(() => service.health.some((entry) => entry.reason.includes("catalog_observation_failed")))
    .toBe(true);
  service.failDiscovery(false);
  service.failPeers(false);
  expect((await bridge.tool("read")).result.isError).toBe(false);
  expect(service.initializes()).toBe(2);
  service.loseMutationReply();
  expect((await mutated).result.isError).toBe(true);
  expect((await bridge.tool("read")).result.isError).toBe(false);
  expect(service.initializes()).toBe(2);
  expect(service.calls.filter((name) => name === "mutate")).toHaveLength(1);
  service.disablePeers();
  expect((await bridge.list()).result.tools.map((tool) => tool.name)).toEqual(names.slice(0, 3));
});

it("advertises authenticated peer settings before native proof settles, while invocations still require fresh proof", async () => {
  const service = await recoveryService({ peerMessages: "on", nativePeerProofRequired: true });
  const bridge = rawReceiptBridge("fleet", await linkedHome(service.url, true), service.url, false, 500);
  await bridge.init();
  expect((await bridge.list()).result.tools.map((tool) => tool.name)).toEqual([
    "message_clankie",
    "clankie_tools",
    "clankie_call",
    "list_fleet_seats",
    "message_peer",
  ]);
  expect(service.peerRequests()).toBe(0);
  const denied = await bridge.tool("list_fleet_seats");
  expect(denied.error?.message).toContain("403: native_peer_sender_required");
  expect(service.peerRequests()).toBe(1);
  service.setPeerMessages("off");
  expect((await bridge.list()).result.tools.map((tool) => tool.name)).toEqual([
    "message_clankie",
    "clankie_tools",
    "clankie_call",
  ]);
  expect(service.peerRequests()).toBe(1);
});
