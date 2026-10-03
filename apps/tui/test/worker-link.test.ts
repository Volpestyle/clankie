import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bin = join(import.meta.dirname, "..", "..", "..", "integrations", "claude-plugin", "worker", "bin");
const TOKEN = "t".repeat(43);

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A stand-in for Clankie's link listener: one event in the mailbox, then nothing. */
async function fakeService() {
  const seen: Seen[] = [];
  let delivered = false;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += String(chunk)));
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://x").pathname;
      seen.push({ method: request.method ?? "", path, authorization: request.headers.authorization, body });
      response.setHeader("content-type", "application/json");
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
      response.end(JSON.stringify({ schemaVersion: 1, received: true }));
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
async function linkedHome(url: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "clankie-link-home-"));
  await mkdir(join(home, ".clankie", "links"), { recursive: true });
  await writeFile(
    join(home, ".clankie", "links", "pc.json"),
    JSON.stringify({ schemaVersion: 1, fleet: "pc", socket: SOCKET, url, token: TOKEN }),
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
  it("serves the seat channel and message_clankie over the link, without the clankie CLI", async () => {
    const service = await fakeService();
    const home = await linkedHome(service.url);
    // The shim reads its parent's command line, as it reads Claude's in a real
    // launch; this parent carries the approved channel flag.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `require("node:child_process").spawn(process.execPath, [${JSON.stringify(join(bin, "swarm-mcp.mjs"))}], { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0))`,
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
      result: { tools: [{ name: "message_clankie" }] },
    });
    write({
      id: 3,
      method: "tools/call",
      params: { name: "message_clankie", arguments: { text: "Blocked on X" } },
    });
    expect(await waitFor((line) => line.id === 3)).toMatchObject({
      result: { isError: false, content: [{ type: "text", text: "Sent to Clankie." }] },
    });

    const message = service.seen.find((request) => request.path.endsWith("/messages"));
    expect(message).toMatchObject({
      method: "POST",
      path: "/v1/fleet/seats/w8%3Ap3/messages",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(message!.body)).toEqual({ schemaVersion: 1, text: "Blocked on X" });
    expect(service.seen.find((request) => request.path.endsWith("/events"))?.authorization).toBe(
      `Bearer ${TOKEN}`,
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

  it("refuses a pane in a Herdr session none of his links name", async () => {
    const service = await fakeService();
    const home = await linkedHome(service.url);
    const child = spawn(process.execPath, [join(bin, "swarm-mcp.mjs")], {
      env: { PATH: process.env.PATH, HOME: home, HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/other.sock" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
    const [code] = (await once(child, "exit")) as [number];
    expect(code).toBe(1);
    expect(stderr).toContain("no link to Clankie for this Herdr session");
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
