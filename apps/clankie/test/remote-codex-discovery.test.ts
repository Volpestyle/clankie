import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { startCodexAppServerSeat } from "../src/captain/codex-app-server.ts";
import { RemoteCodexSeats } from "../src/remote-codex-seats.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";

it("keeps the bridge's first catalog pending until the sole native thread binds, without a second SessionStart", async () => {
  const home = await mkdtemp(join(tmpdir(), "private-codex-discovery-"));
  const fleet = { id: "pc", session: "desktop", ssh: { host: "pc", shell: "powershell" as const } };
  const lifetime = {
    pid: 20,
    startTime: "2026-10-03T00:00:01.0000001Z",
    executable: "C:\\codex.exe",
    port: 45000,
  };
  const binding = { session: "desktop", socketPath: "fixture" };
  const shell = { pid: 10, startTime: "2026-10-03T00:00:00.0000001Z" };
  const seats = new RemoteCodexSeats(async () => fleet);
  const registration = seats.register({ fleet, pane: "w1:p1", binding, shell, server: lifetime }, () => true);
  const view = {
    fleet: "pc",
    pane: "w1:p1",
    binding,
    shell,
    processes: [{ pid: 30, startTime: "view" }],
    nativeOccupantId: occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: "thread" }),
  };
  expect(await seats.allows(fleet, view, lifetime)).toBe(false);
  let denied!: () => void;
  const firstDenied = new Promise<void>((resolve) => {
    denied = resolve;
  });
  let bound = false;
  let attempts = 0;
  let sessionStarts = 0;
  const http = createServer((request, response) => {
    let bytes = "";
    request.on("data", (chunk) => (bytes += String(chunk)));
    request.on("end", () => {
      const rpc = JSON.parse(bytes) as { id?: number; method: string };
      response.setHeader("content-type", "application/json");
      if (!bound) {
        attempts++;
        denied();
        response.writeHead(403);
        response.end("{}");
        return;
      }
      response.setHeader("mcp-session-id", "fixture");
      if (rpc.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      const result =
        rpc.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : { tools: [{ name: "linear_get_issue", inputSchema: { type: "object" } }] };
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const httpPort = (http.address() as { port: number }).port;
  await mkdir(join(home, ".clankie", "links"), { recursive: true });
  await writeFile(
    join(home, ".clankie", "links", "pc.json"),
    JSON.stringify({
      schemaVersion: 2,
      authentication: "local-process",
      fleet: "pc",
      socket: "fixture",
      url: `http://127.0.0.1:${httpPort}`,
    }),
  );
  const bridgeModule = new URL(
    "../../../integrations/claude-plugin/worker/bin/seat-channel.mjs",
    import.meta.url,
  ).href;
  const bridge = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runSeatChannel} from ${JSON.stringify(bridgeModule)};runSeatChannel({paneId:"w1:p1",parentArgv:"codex app-server"});`,
    ],
    {
      env: { ...process.env, HOME: home, HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "fixture" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const protocol = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(protocol, "listening");
  const port = (protocol.address() as { port: number }).port;
  let peer: WebSocket | undefined;
  protocol.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (bytes) => {
      const rpc = JSON.parse(String(bytes)) as { id?: number; method: string };
      if (rpc.id === undefined) return;
      const result =
        rpc.method === "thread/loaded/list"
          ? { data: ["thread"], nextCursor: null }
          : rpc.method === "thread/read"
            ? { thread: { id: "thread" } }
            : {};
      socket.send(JSON.stringify({ id: rpc.id, result }));
    });
  });
  let buffer = "";
  let catalogResolve!: (value: Record<string, unknown>) => void;
  const catalog = new Promise<Record<string, unknown>>((resolve) => (catalogResolve = resolve));
  bridge.stdout.on("data", (bytes) => {
    buffer += String(bytes);
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const row = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (row.id === 2) catalogResolve(row);
    }
  });
  bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  let seat: Awaited<ReturnType<typeof startCodexAppServerSeat>> | undefined;
  try {
    seat = await startCodexAppServerSeat({
      cwd: "C:\\fixture",
      startView: async () => {
        sessionStarts++;
        await firstDenied;
      },
      server: async () => ({
        endpoint: "fixture",
        failure: () => undefined,
        output: () => "",
        close: async () => {
          registration.release();
        },
        remoteRegistration: {
          ...registration,
          bindThread: (id, check) => {
            registration.bindThread(id, check);
            bound = true;
          },
        },
        connect: async () => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}`);
          await once(socket, "open");
          return socket;
        },
      }),
    });
    const reply = await catalog;
    expect(reply).toMatchObject({
      result: { tools: [{ name: "message_clankie" }, { name: "linear_get_issue" }] },
    });
    expect(sessionStarts).toBe(1);
    expect(attempts).toBeGreaterThan(0);
    expect(await seats.allows(fleet, view, lifetime)).toBe(true);
    peer!.send(
      JSON.stringify({ method: "turn/started", params: { threadId: "foreign", turn: { id: "turn" } } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await seats.allows(fleet, view, lifetime)).toBe(false);
  } finally {
    await seat?.close();
    bridge.kill();
    peer?.terminate();
    protocol.close();
    http.closeAllConnections();
    http.close();
    await rm(home, { recursive: true, force: true });
  }
}, 8000);
