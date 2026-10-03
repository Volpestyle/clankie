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

// The provider and native TUI are replaced by one local protocol fixture. No
// native process, credentials, account probe or model request leaves this test.
describe("trusted native seat policy", () => {
  async function fixture(
    policy: import("../src/captain/codex-app-server.ts").CodexNativePolicy,
    callerEnv?: Record<string, string>,
  ) {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (typeof address !== "object" || address === null) throw Error("No address");
    const methods: string[] = [];
    let peer: WebSocket | undefined;
    let closed = 0;
    let views = 0;
    const launches: unknown[] = [];
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (bytes) => {
        const request = JSON.parse(String(bytes)) as { id?: number; method: string };
        methods.push(request.method);
        if (request.id === undefined) return;
        const result =
          request.method === "thread/loaded/list"
            ? { data: ["root"] }
            : request.method === "thread/read"
              ? { thread: { id: "root" } }
              : request.method === "thread/resume"
                ? { thread: { turns: [] } }
                : request.method === "turn/start"
                  ? { turn: { id: "turn" } }
                  : request.method === "turn/steer"
                    ? { turnId: "turn" }
                    : {};
        socket.send(JSON.stringify({ id: request.id, result }));
      });
    });
    cleanups.push(() => {
      peer?.terminate();
      server.close();
    });
    const { startCodexAppServerSeat } = await import("../src/captain/codex-app-server.ts");
    const pending = startCodexAppServerSeat({
      cwd: "/fixture",
      ...(callerEnv ? { env: callerEnv } : {}),
      policy,
      startView: async () => {
        views++;
      },
      server: async (input) => {
        launches.push(input);
        return {
          endpoint: "fixture",
          failure: () => undefined,
          output: () => "",
          close: async () => {
            closed++;
          },
          connect: async () => {
            const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}`);
            await once(socket, "open");
            return socket;
          },
        };
      },
    });
    return {
      pending,
      methods,
      event: (event: CodexSeatEvent) => peer!.send(JSON.stringify(event)),
      closed: () => closed,
      views: () => views,
      launches,
    };
  }

  it("gates every send and steer and audits descendants before root filtering", async () => {
    const seen: CodexSeatEvent[] = [];
    const gates: string[] = [];
    const f = await fixture({
      connected: async (read) => {
        await expect(read.request("account/read", {})).rejects.toThrow("refresh");
        await expect(read.request("turn/start" as "thread/list", {})).rejects.toThrow("read-only");
        await expect(read.request("account/sessions/list" as "thread/list", {})).rejects.toThrow("read-only");
        await read.request("account/read", { refreshToken: false });
      },
      beforeTurn: async ({ threadId, read }) => {
        gates.push(threadId);
        await read.request("account/rateLimits/read", {});
      },
      audit: async (event) => {
        seen.push(event);
      },
      failed: async () => {
        throw Error("unexpected");
      },
    });
    const seat = await f.pending;
    await seat.send("first");
    f.event({ method: "turn/started", params: { threadId: "root", turn: { id: "turn" } } });
    f.event({ method: "thread/tokenUsage/updated", params: { threadId: "child" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await seat.send("second");
    expect(gates).toEqual(["root", "root"]);
    expect(f.methods.filter((method) => /turn\/(start|steer)/u.test(method))).toEqual([
      "turn/start",
      "turn/steer",
    ]);
    expect(seen.some((event) => event.params.threadId === "child")).toBe(true);
    for (const method of ["turn/start", "turn/steer"])
      expect(f.methods[f.methods.indexOf(method) - 1]).toBe("account/rateLimits/read");
    await seat.close();
  });

  it("awaits containment failure handling and never dispatches after guard refusal", async () => {
    let stopped = false;
    const f = await fixture({
      connected: async () => {},
      audit: async () => {},
      beforeTurn: async () => {
        throw Error("stale quota");
      },
      failed: async () => {
        await Promise.resolve();
        stopped = true;
      },
    });
    const seat = await f.pending;
    await expect(seat.send("blocked")).rejects.toThrow("stale quota");
    expect(stopped).toBe(true);
    expect(f.closed()).toBe(1);
    await expect(seat.send("again")).rejects.toThrow();
    expect(f.methods).not.toContain("turn/start");
  });

  it("closes on async descendant audit failure and preserves containment stop errors", async () => {
    const f = await fixture({
      connected: async () => {},
      beforeTurn: async () => {},
      audit: async () => {
        throw Error("unadmitted descendant");
      },
      failed: async () => {
        throw Error("container unavailable");
      },
    });
    const seat = await f.pending;
    f.event({ method: "thread/started", params: { threadId: "unknown" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.closed()).toBe(1);
    await expect(seat.close()).rejects.toThrow("containment failed");
    expect(f.methods).not.toContain("turn/start");
  });

  it("passes only the complete trusted server environment with final permission overrides", async () => {
    const saved = process.env.CLANKIE_OPERATOR_TOKEN;
    process.env.CLANKIE_OPERATOR_TOKEN = "fixture-secret";
    try {
      const f = await fixture(
        {
          launch: {
            environment: { PATH: "/trusted/bin", HOME: "/protected/home" },
            socketRoot: "/protected/socket",
            config: ["features.multi_agent=false"],
          },
          connected: async () => {},
          beforeTurn: async () => {},
          audit: async () => {},
          failed: async () => {},
        },
        {
          CLANKIE_OPERATOR_TOKEN: "caller-operator",
          CLANKIE_CAPTAIN_TOKEN: "caller-captain",
          OPENAI_API_KEY: "caller-provider",
          UNKNOWN_SECRET: "caller-unknown",
          HOME: "/caller-auth",
        },
      );
      const seat = await f.pending;
      expect(f.launches).toEqual([
        expect.objectContaining({
          inheritEnvironment: false,
          env: { PATH: "/trusted/bin", HOME: "/protected/home" },
          socketRoot: "/protected/socket",
          configArgs: ["-c", "features.multi_agent=false"],
        }),
      ]);
      expect(JSON.stringify(f.launches)).not.toContain("fixture-secret");
      expect(JSON.stringify(f.launches)).not.toContain("caller-");
      await seat.close();
    } finally {
      if (saved === undefined) delete process.env.CLANKIE_OPERATOR_TOKEN;
      else process.env.CLANKIE_OPERATOR_TOKEN = saved;
    }
  });

  it("rechecks initial brief authority after asynchronous native policy admission", async () => {
    let active = true;
    const f = await fixture({
      connected: async () => {},
      audit: async () => {},
      failed: async () => {},
      beforeTurn: async () => {
        await Promise.resolve();
        active = false;
      },
    });
    const seat = await f.pending;
    await expect(
      seat.send("initial", async () => {
        if (!active) throw Error("source authority revoked");
      }),
    ).rejects.toThrow("source authority revoked");
    expect(f.methods).not.toContain("turn/start");
    // A later independently authorized follow-up does not inherit the initial guard.
    await seat.send("follow-up");
    expect(f.methods).toContain("turn/start");
    await seat.close();
  });

  it("requires monitoring before attaching the native TUI", async () => {
    let stopped = false;
    const f = await fixture({
      connected: async () => {
        throw Error("monitor unavailable");
      },
      beforeTurn: async () => {},
      audit: async () => {},
      failed: async () => {
        stopped = true;
      },
    });
    await expect(f.pending).rejects.toThrow("monitor unavailable");
    expect(stopped).toBe(true);
    expect(f.views()).toBe(0);
    expect(f.closed()).toBe(1);
  });
});
