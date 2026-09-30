import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { CodexAppServerClient, type CodexSeatEvent } from "../src/captain/codex-app-server.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function connection(timeoutMs = 500) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing test address");
  const connected = once(server, "connection");
  const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}`);
  await once(socket, "open");
  const [peer] = (await connected) as [WebSocket];
  const events: CodexSeatEvent[] = [];
  const client = new CodexAppServerClient(socket, (event) => events.push(event), timeoutMs);
  cleanups.push(() => {
    client.close();
    peer.terminate();
    server.close();
  });
  const next = async () => JSON.parse(String((await once(peer, "message"))[0])) as Record<string, unknown>;
  return { client, peer, events, next };
}

describe("Codex app-server protocol", () => {
  it("completes initialization before announcing initialized", async () => {
    const { client, peer, next } = await connection();
    const request = next();
    const initialized = client.initialize();
    const message = await request;
    expect(message).toMatchObject({ method: "initialize", params: { clientInfo: { name: "clankie" } } });
    const notification = next();
    peer.send(JSON.stringify({ id: message.id, result: {} }));
    await initialized;
    expect(await notification).toEqual({ method: "initialized", params: {} });
  });

  it("correlates out-of-order replies and preserves a multiline large brief", async () => {
    const { client, peer, next } = await connection();
    const brief = "first line\n`literal` $HOME 🌻\n" + "long brief\n".repeat(10_000);
    const request = next();
    const first = client.request("turn/start", { threadId: "one", input: [{ type: "text", text: brief }] });
    const a = await request;
    expect(a.params).toEqual({ threadId: "one", input: [{ type: "text", text: brief }] });
    const secondRequest = next();
    const second = client.request("thread/read", { threadId: "one" });
    const b = await secondRequest;
    peer.send(JSON.stringify({ id: b.id, result: { thread: "one" } }));
    peer.send(JSON.stringify({ id: a.id, result: { turn: "two" } }));
    await expect(second).resolves.toEqual({ thread: "one" });
    await expect(first).resolves.toEqual({ turn: "two" });
  });

  it("passes failed/interrupted completion events intact and never answers approvals", async () => {
    const { peer, events } = await connection();
    const messages: unknown[] = [];
    peer.on("message", (message) => messages.push(message));
    peer.send(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "one", turn: { id: "two", status: "failed", error: { message: "quota" } } },
      }),
    );
    peer.send(
      JSON.stringify({ id: 8, method: "item/commandExecution/requestApproval", params: { threadId: "one" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([
      {
        method: "turn/completed",
        params: { threadId: "one", turn: { id: "two", status: "failed", error: { message: "quota" } } },
      },
      { method: "item/commandExecution/requestApproval", params: { threadId: "one" } },
    ]);
    expect(messages).toEqual([]);
  });

  it("rejects protocol errors without replaying a request", async () => {
    const { client, peer, next } = await connection();
    const received = next();
    const request = client.request("turn/steer", { expectedTurnId: "old" });
    const assertion = expect(request).rejects.toThrow("no active turn");
    const message = await received;
    peer.send(JSON.stringify({ id: message.id, error: { code: -32600, message: "no active turn" } }));
    await assertion;
  });

  it("rejects pending requests on disconnect and refuses new sends", async () => {
    const { client, peer } = await connection();
    const assertion = expect(client.request("turn/start", {})).rejects.toThrow("disconnected");
    peer.close();
    await assertion;
    await expect(client.request("turn/start", {})).rejects.toThrow("disconnected");
  });

  it("marks a timeout uncertain instead of claiming non-delivery", async () => {
    const { client } = await connection(10);
    await expect(client.request("turn/start", {})).rejects.toThrow("delivery is uncertain");
  });
});
