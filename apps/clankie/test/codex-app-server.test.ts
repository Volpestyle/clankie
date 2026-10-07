import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      { method: "item/commandExecution/requestApproval", params: { threadId: "one" }, requestId: 8 },
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

it.each(["metadata", "legacy-field", "legacy-method"])(
  "keeps the same server alive after Herdr's resume readiness timeout and subscribes with %s",
  async (compatibility) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing test address");
    let peer: WebSocket | undefined;
    let closed = 0;
    let pending = 0;
    let loaded = false;
    const methods: string[] = [];
    const subscriptions: Array<Record<string, unknown>> = [];
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (bytes) => {
        const request = JSON.parse(String(bytes)) as {
          id?: number;
          method: string;
          params: Record<string, unknown>;
        };
        methods.push(request.method);
        if (request.id === undefined) return;
        if (request.method === "initialize")
          expect(request.params.capabilities).toEqual({ experimentalApi: true });
        if (request.method === "thread/resume") {
          subscriptions.push(request.params);
          if (compatibility === "legacy-field" && request.params.excludeTurns === true) {
            socket.send(
              JSON.stringify({
                id: request.id,
                error: { code: -32602, message: "unknown field `excludeTurns`" },
              }),
            );
            return;
          }
        }
        if (request.method === "thread/turns/list") {
          expect(request.params).toEqual({
            threadId: "saved-thread",
            limit: 1,
            sortDirection: "desc",
            itemsView: "full",
          });
          if (compatibility === "legacy-method") {
            socket.send(
              JSON.stringify({ id: request.id, error: { code: -32601, message: "method not found" } }),
            );
            return;
          }
        }
        const result =
          request.method === "thread/loaded/list"
            ? { data: loaded ? ["saved-thread"] : [] }
            : request.method === "thread/read"
              ? { thread: { id: "saved-thread" } }
              : request.method === "thread/resume"
                ? { thread: { id: "saved-thread", turns: [] } }
                : request.method === "thread/turns/list"
                  ? { data: [] }
                  : request.method === "turn/start"
                    ? { turn: { id: "brief-turn" } }
                    : {};
        socket.send(JSON.stringify({ id: request.id, result }));
      });
    });
    cleanups.push(() => {
      peer?.terminate();
      server.close();
    });
    const { startCodexAppServerSeat } = await import("../src/captain/codex-app-server.ts");
    const starting = startCodexAppServerSeat({
      cwd: "/fixture",
      resumeThreadId: "saved-thread",
      threadStartTimeoutMs: 10,
      onThreadPending: () => {
        pending++;
      },
      server: async () => ({
        endpoint: "unix:///fixture/socket",
        connect: async () => {
          const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}`);
          await once(socket, "open");
          return socket;
        },
        failure: () => undefined,
        output: () => "",
        close: async () => {
          closed++;
        },
      }),
      startView: async (args) => {
        expect(args.slice(-2)).toEqual(["resume", "saved-thread"]);
        throw new Error(
          JSON.stringify({
            error: { code: "timeout", message: "timed out waiting for agent startup" },
            id: "cli:agent:start",
          }),
        );
      },
    });
    await vi.waitFor(() => expect(pending).toBe(1));
    expect(closed).toBe(0);
    expect(methods).not.toContain("turn/start");
    loaded = true;
    const seat = await starting;
    expect(seat.threadId).toBe("saved-thread");
    expect(await seat.send("continue the original assignment")).toEqual({
      turnId: "brief-turn",
      state: "started",
    });
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(subscriptions[0]).toEqual({ threadId: "saved-thread", excludeTurns: true });
    expect(subscriptions.length).toBe(compatibility === "metadata" ? 1 : 2);
    if (compatibility !== "metadata") expect(subscriptions[1]).toEqual({ threadId: "saved-thread" });
    expect(closed).toBe(0);
    await seat.close();
    expect(closed).toBe(1);
  },
);

// The provider and native TUI are replaced by one local protocol fixture. No
// native process, credentials, account probe or model request leaves this test.
describe("trusted native seat policy", () => {
  it("does not borrow the caller's copied home when a trusted policy replaces the complete environment", async () => {
    const { startCodexAppServerSeat } = await import("../src/captain/codex-app-server.ts");
    const startView = vi.fn();
    await expect(
      startCodexAppServerSeat({
        cwd: "/fixture",
        env: { CODEX_HOME: "/caller-copy" },
        catalogRefreshHome: "/caller-copy",
        policy: {
          launch: { environment: {}, socketRoot: "/unused", config: [] },
          connected: async () => {},
          beforeTurn: async () => {},
          audit: async () => {},
          failed: async () => {},
        },
        startView,
      }),
    ).rejects.toThrow("configuration must belong to this exact server");
    expect(startView).not.toHaveBeenCalled();
  });

  async function fixture(
    policy: import("../src/captain/codex-app-server.ts").CodexNativePolicy,
    callerEnv?: Record<string, string>,
    catalog?: { result: unknown; read(): void; validate?(): Promise<void> },
    refresh?: { home: string; signal: string },
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
        if (request.method === "mcpServerStatus/list") catalog?.read();
        const result =
          request.method === "hooks/list"
            ? { data: [{ cwd: "/fixture", hooks: [], errors: [] }] }
            : request.method === "mcpServerStatus/list"
              ? catalog?.result
              : request.method === "thread/loaded/list"
                ? { data: ["root"] }
                : request.method === "thread/read"
                  ? { thread: { id: "root" } }
                  : request.method === "thread/resume"
                    ? { thread: { id: "root", turns: [] } }
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
      ...(refresh ? { catalogRefreshHome: refresh.home } : {}),
      ...(callerEnv ? { env: callerEnv } : {}),
      policy,
      startView: async () => {
        views++;
      },
      server: async (input) => {
        launches.push(input);
        return {
          endpoint: "fixture",
          ...(refresh ? { catalogSignalPath: refresh.signal } : {}),
          ...(catalog
            ? {
                waitForClankieCatalog: true as const,
                ...(catalog.validate ? { validateCatalog: catalog.validate } : {}),
              }
            : {}),
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

  it("retains the private bridge signal while leaving native refresh mutations to the durable coordinator", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "owned-catalog-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "worker-codex", "seat-fixture");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.toml"), "");
    const signal = join(root, "catalog-changed");
    const f = await fixture(
      {
        connected: async () => {},
        beforeTurn: async () => {},
        audit: async () => {},
        failed: async () => {},
      },
      { CODEX_HOME: home },
      undefined,
      { home, signal },
    );
    const seat = await f.pending;
    expect(f.launches).toMatchObject([{ catalogRefresh: true }]);
    writeFileSync(signal, randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.methods).not.toContain("config/mcpServer/reload");
    expect(f.methods).not.toContain("config/value/write");
    expect(f.methods).not.toContain("turn/start");
    await seat.close();
    const count = f.methods.length;
    writeFileSync(signal, randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.methods).toHaveLength(count);
  });

  it.each([
    {},
    { data: [] },
    { data: [{ name: "clankie", runtimeStatus: "connected", tools: { message_clankie: {} } }] },
    { data: [{ name: "clankie", runtimeStatus: "starting", tools: { message_clankie: {} } }] },
    {
      data: [
        { name: "clankie", runtimeStatus: "connected", tools: { message_clankie: {} }, toolsError: "failed" },
      ],
    },
    {
      data: [{ name: "clankie", runtimeStatus: "connected", tools: { message_clankie: {} } }],
      nextCursor: "more",
    },
    {
      data: [
        { name: "clankie", runtimeStatus: "connected", tools: { message_clankie: {} } },
        { name: "clankie", runtimeStatus: "connected", tools: { message_clankie: {} } },
      ],
    },
  ])("never sends the first brief on an incomplete or ambiguous native catalog %j", async (result) => {
    let now = Date.now();
    const f = await fixture(
      {
        connected: async () => {},
        beforeTurn: async () => {},
        audit: async () => {},
        failed: async () => {},
      },
      undefined,
      {
        result,
        read: () => {
          now += 21_000;
        },
      },
    );
    const seat = await f.pending;
    seat.expectTools?.(["linear_get_issue"]);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await expect(seat.send("first")).rejects.toThrow("no first turn was sent");
      expect(f.methods).toContain("mcpServerStatus/list");
      expect(f.methods).not.toContain("turn/start");
    } finally {
      clock.mockRestore();
      await seat.close();
    }
  });

  it("permits an explicitly empty project expectation for a generic no-grant hire", async () => {
    const f = await fixture(
      {
        connected: async () => {},
        beforeTurn: async () => {},
        audit: async () => {},
        failed: async () => {},
      },
      undefined,
      {
        result: { data: [{ name: "clankie", runtimeStatus: "connected", tools: { message_clankie: {} } }] },
        read: () => {},
      },
    );
    const seat = await f.pending;
    seat.expectTools?.([]);
    try {
      expect(await seat.send("generic brief")).toMatchObject({ turnId: "turn" });
    } finally {
      await seat.close();
    }
  });

  it.each([1, 2])("refuses installed bridge drift at validation %i before any first turn", async (failAt) => {
    let validations = 0;
    const f = await fixture(
      {
        connected: async () => {},
        beforeTurn: async () => {},
        audit: async () => {},
        failed: async () => {},
      },
      undefined,
      {
        result: {
          data: [
            {
              name: "clankie",
              runtimeStatus: "connected",
              tools: { message_clankie: {}, linear_get_issue: {} },
            },
          ],
        },
        read: () => {},
        validate: async () => {
          if (++validations === failAt) throw new Error("worker bridge changed");
        },
      },
    );
    const seat = await f.pending;
    seat.expectTools?.(["linear_get_issue"]);
    try {
      await expect(seat.send("never dispatch")).rejects.toThrow("worker bridge changed");
      expect(f.methods).not.toContain("turn/start");
      expect(validations).toBe(failAt);
    } finally {
      await seat.close();
    }
  });

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

  it.each(["quota", "owner"])(
    "the final synchronous dispatch latch refuses %s loss during initial source guard",
    async (reason) => {
      let revoked = false,
        release!: () => void;
      const f = await fixture({
        connected: async () => {},
        audit: async () => {},
        beforeTurn: async () => {},
        failed: async () => {},
        dispatch: () => {
          if (revoked) throw Error(`${reason} revoked`);
        },
      });
      const seat = await f.pending;
      const pending = seat.send(
        "initial",
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const rejected = expect(pending).rejects.toThrow(`${reason} revoked`);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      revoked = true;
      release();
      await rejected;
      expect(f.methods).not.toContain("turn/start");
      expect(f.methods).not.toContain("turn/steer");
      await seat.close().catch(() => {});
    },
  );

  it("records the actual new-turn method when the previous turn completes during the source guard", async () => {
    const events: string[] = [],
      dispatches: unknown[] = [];
    let release!: () => void;
    const f = await fixture({
      connected: async () => {},
      audit: async (event) => {
        events.push(event.method);
      },
      beforeTurn: async () => {},
      failed: async () => {},
      dispatch: (input) => {
        dispatches.push(input);
      },
    });
    const seat = await f.pending;
    f.event({ method: "turn/started", params: { threadId: "root", turn: { id: "previous" } } });
    await vi.waitFor(() => expect(events).toContain("turn/started"));
    const pending = seat.send(
      "next",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.event({
      method: "turn/completed",
      params: { threadId: "root", turn: { id: "previous", status: "completed" } },
    });
    await vi.waitFor(() => expect(events).toContain("turn/completed"));
    release();
    await pending;
    expect(dispatches).toEqual([{ threadId: "root", method: "turn/start" }]);
    expect(f.methods).toContain("turn/start");
    expect(f.methods).not.toContain("turn/steer");
    await seat.close();
  });

  it("refuses an asynchronous dispatch hook before any native turn RPC", async () => {
    const f = await fixture({
      connected: async () => {},
      audit: async () => {},
      beforeTurn: async () => {},
      failed: async () => {},
      dispatch: async () => {},
    });
    const seat = await f.pending;
    await expect(seat.send("no async authority")).rejects.toThrow("must be synchronous");
    expect(f.methods).not.toContain("turn/start");
    await seat.close().catch(() => {});
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

const nativeQuestion = {
  threadId: "one",
  turnId: "turn",
  itemId: "call",
  isBlocking: true,
  questions: [
    {
      id: "docs",
      header: "Docs",
      question: "Which docs worktree?",
      isOther: true,
      isSecret: false,
      options: [{ label: "Existing", description: "Use the existing worktree." }],
    },
  ],
};

it.each(["request-9", 9])(
  "replies once to native question %s without starting or steering a turn",
  async (requestId) => {
    const { client, peer, events, next } = await connection();
    peer.send(
      JSON.stringify({ id: requestId, method: "item/tool/requestUserInput", params: nativeQuestion }),
    );
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ requestId, params: nativeQuestion });
    expect(client.pendingQuestion("one", requestId)).toMatchObject({
      requestId,
      questions: nativeQuestion.questions,
    });
    expect(client.pendingQuestion("foreign-thread", requestId)).toBeUndefined();
    const response = next();
    const answering = client.answerQuestion("one", {
      requestId,
      answers: { docs: { answers: ["Existing"] } },
    });
    expect(await response).toEqual({
      id: requestId,
      result: { answers: { docs: { answers: ["Existing"] } } },
    });
    await expect(
      client.answerQuestion("one", { requestId, answers: { docs: { answers: ["Other"] } } }),
    ).resolves.toMatchObject({ outcome: "refused" });
    peer.send(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "one", requestId } }));
    await expect(answering).resolves.toEqual({ outcome: "resolved" });
    expect(client.pendingQuestion("one", requestId)).toBeUndefined();
    await expect(
      client.answerQuestion("one", { requestId, answers: { docs: { answers: ["Other"] } } }),
    ).resolves.toMatchObject({ outcome: "refused" });
  },
);

it("refuses an owner-first answer, including resolution during the dispatch guard", async () => {
  const { client, peer, events } = await connection();
  peer.send(JSON.stringify({ id: 7, method: "item/tool/requestUserInput", params: nativeQuestion }));
  await vi.waitFor(() => expect(events).toHaveLength(1));
  const messages: unknown[] = [];
  peer.on("message", (message) => messages.push(message));
  const result = await client.answerQuestion(
    "one",
    { requestId: 7, answers: { docs: { answers: ["lead"] } } },
    async () => {
      peer.send(
        JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "one", requestId: 7 } }),
      );
      await vi.waitFor(() => expect(events).toHaveLength(2));
    },
  );
  expect(result).toMatchObject({ outcome: "refused", detail: expect.stringContaining("already_resolved") });
  expect(messages).toEqual([]);
});

it("does not answer approvals, foreign threads, unknown IDs or incomplete question maps", async () => {
  const { client, peer, events } = await connection();
  peer.send(JSON.stringify({ id: 7, method: "item/tool/requestUserInput", params: nativeQuestion }));
  peer.send(
    JSON.stringify({ id: 8, method: "item/commandExecution/requestApproval", params: { threadId: "one" } }),
  );
  await vi.waitFor(() => expect(events).toHaveLength(2));
  const messages: unknown[] = [];
  peer.on("message", (message) => messages.push(message));
  for (const [threadId, requestId, answers] of [
    ["foreign", 7, { docs: { answers: ["lead"] } }],
    ["one", 8, { docs: { answers: ["lead"] } }],
    ["one", 7, { wrong: { answers: ["lead"] } }],
  ] as const) {
    expect(await client.answerQuestion(threadId, { requestId, answers })).toMatchObject({
      outcome: "refused",
    });
  }
  peer.send(
    JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "foreign", requestId: 7 } }),
  );
  await vi.waitFor(() => expect(events).toHaveLength(3));
  expect(client.pendingQuestion("one", 7)).toBeDefined();
  expect(messages).toEqual([]);
});

it("keeps a lost native response uncertain and fences every retry", async () => {
  const { client, peer, events, next } = await connection(30);
  peer.send(JSON.stringify({ id: 7, method: "item/tool/requestUserInput", params: nativeQuestion }));
  await vi.waitFor(() => expect(events).toHaveLength(1));
  const response = next();
  const first = client.answerQuestion("one", { requestId: 7, answers: { docs: { answers: ["lead"] } } });
  await response;
  await expect(first).resolves.toMatchObject({ outcome: "unconfirmed" });
  expect(
    await client.answerQuestion("one", { requestId: 7, answers: { docs: { answers: ["retry"] } } }),
  ).toMatchObject({ outcome: "refused" });
});
