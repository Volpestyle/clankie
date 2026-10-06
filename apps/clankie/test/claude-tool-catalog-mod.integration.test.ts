import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";

// Execute the shipped original mod and real authenticated HTTP report helper.
// The native engine API is an explicit surrogate; no Claude/model is launched.
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type Event = Record<string, unknown>;
type Hook = (
  engine: unknown,
  event: Event,
  next: (event: Event) => Promise<unknown>,
) => unknown | Promise<unknown>;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clankie-claude-catalog-mod-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const reports: Event[] = [];
  let reply = {
    status: 200,
    body: { status: "matched" } as Event,
    stall: false,
    disconnect: false,
    disconnectBody: false,
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      expect(request.url).toBe("/v1/fleet/seats/w1%3Ap1/tool-catalog");
      expect(request.headers["x-clankie-pane"]).toBe("w1:p1");
      reports.push(JSON.parse(body));
      if (reply.disconnect) {
        request.socket.destroy();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.statusCode = reply.status;
      if (reply.disconnectBody) {
        response.flushHeaders();
        setTimeout(() => request.socket.destroy(), 30);
        return;
      }
      if (reply.stall) {
        response.flushHeaders();
        return;
      }
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as { port: number };
  await mkdir(join(directory, "links"));
  await writeFile(
    join(directory, "links", "test.json"),
    JSON.stringify({
      schemaVersion: 2,
      authentication: "local-process",
      fleet: "default",
      socket: "fixture",
      url: `http://127.0.0.1:${address.port}`,
    }),
  );
  const source = await readFile(
    new URL("../../../integrations/claude-plugin/worker/mods/tool-catalog.mjs", import.meta.url),
    "utf8",
  );
  const module = (await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(`${source}\n// ${directory}`)}`
  )) as { register(on: (name: string, matcher: Event | Hook, hook?: Hook) => void): void };
  const hooks = new Map<string, { matcher?: Event; hook: Hook }[]>();
  module.register((name, matcher, hook) => {
    const entries = hooks.get(name) ?? [];
    entries.push(typeof matcher === "function" ? { hook: matcher } : { matcher, hook: hook! });
    hooks.set(name, entries);
  });
  let sessionId = "original-session";
  let now = Date.now();
  const after: { callback: () => Promise<unknown>; cancelled: boolean }[] = [];
  const every: { callback: () => Promise<unknown>; cancelled: boolean }[] = [];
  const timer = (queue: typeof after, callback: () => Promise<unknown>) => {
    const entry = { callback, cancelled: false };
    queue.push(entry);
    return { cancel: () => (entry.cancelled = true) };
  };
  const api = {
    plugin: {
      name: "clankie-worker",
      root: fileURLToPath(new URL("../../../integrations/claude-plugin/worker", import.meta.url)),
    },
    env: {
      get: async (name: string) => ({ HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "fixture" })[name],
    },
    session: { id: async () => sessionId },
    clock: {
      now: async () => now,
      after: (_delay: number, callback: () => Promise<unknown>) => timer(after, callback),
      every: (_delay: number, callback: () => Promise<unknown>) => timer(every, callback),
    },
    agent: { list: vi.fn(async () => [] as { status: string }[]) },
    mcp: {
      connect: vi.fn(async () => ({ isConnected: true, server: "plugin:clankie-worker:clankie" })),
    },
    tool: {
      list: vi.fn(async () => [
        { name: "mcp__plugin_clankie-worker_clankie__message_clankie", mcp: true },
        { name: "mcp__personal__clankie_call", mcp: true },
      ]),
    },
    process: {
      run: vi.fn(
        (args: string[], options: { stdin: string; timeoutMs: number }) =>
          new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
            const child = spawn(process.execPath, args.slice(1), {
              env: {
                ...process.env,
                CLANKIE_STATE: directory,
                HERDR_PANE_ID: "w1:p1",
                HERDR_SOCKET_PATH: "fixture",
              },
              stdio: "pipe",
              timeout: options.timeoutMs,
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => (stdout += String(chunk)));
            child.stderr.on("data", (chunk) => (stderr += String(chunk)));
            child.once("error", reject);
            child.once("exit", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
            child.stdin.end(options.stdin);
          }),
      ),
    },
    ui: { status: vi.fn(), log: vi.fn() },
  };
  const emit = async (
    name: string,
    event: Event,
    next: (event: Event) => Promise<unknown> = async () => ({}),
  ) => {
    const entries = (hooks.get(name) ?? []).filter(
      ({ matcher }) => !matcher || Object.entries(matcher).every(([key, value]) => event[key] === value),
    );
    let call = next;
    for (const entry of entries.toReversed()) {
      const inner = call;
      call = async (input) => entry.hook(api, input, inner);
    }
    return call(event);
  };
  const drain = async () => {
    const pending = after.splice(0);
    for (const entry of pending) if (!entry.cancelled) await entry.callback();
  };
  return {
    api,
    reports,
    emit,
    drain,
    url: `http://127.0.0.1:${address.port}`,
    reply: (status: number, body: Event, stall = false) =>
      (reply = { status, body, stall, disconnect: false, disconnectBody: false }),
    disconnect: () => (reply.disconnect = true),
    disconnectBody: () => (reply.disconnectBody = true),
    link: async (url: string) => {
      const path = join(directory, "links", "test.json");
      const link = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...link, url }));
    },
    switch: (id: string) => (sessionId = id),
    start: async () => {
      await emit("session.start", { isInteractive: true });
      await drain();
    },
    tick: async () => {
      now += 5_000;
      for (const entry of every) if (!entry.cancelled) await entry.callback();
      await drain();
    },
  };
}

test("original Claude mod reports its exact native server catalog repeatedly through the pane link", async () => {
  const f = await fixture();
  await f.start();
  await f.tick();
  expect(f.reports).toHaveLength(2);
  expect(f.reports).toEqual([
    expect.objectContaining({ sessionId: "original-session", tools: ["message_clankie"] }),
    expect.objectContaining({ sessionId: "original-session", tools: ["message_clankie"] }),
  ]);
  expect(f.api.mcp.connect).toHaveBeenCalledTimes(2);
  expect(f.api.mcp.connect).toHaveBeenCalledWith("clankie");
  expect(f.api.ui.log).not.toHaveBeenCalled();
});

test("native pane refusals retain their code and print once across turns and intermittent recovery", async () => {
  const f = await fixture();
  await f.start();
  f.reply(403, { error: "remote_pane_required", detail: "Bearer do-not-display" });
  await f.tick();
  const warning = f.api.ui.log.mock.calls[0]![0];
  expect(warning).toContain("HTTP 403, remote_pane_required");
  expect(warning).toContain("/mcp → reconnect clankie-worker");
  expect(warning).not.toContain("do-not-display");
  const reports = f.reports.length;
  await f.emit("turn.start", { turnId: "another-turn" });
  await f.emit("turn.complete", { turnId: "another-turn" });
  await f.drain();
  expect(f.reports).toHaveLength(reports);
  await f.tick();
  await f.tick();
  expect(f.api.ui.log).toHaveBeenCalledTimes(1);
  f.reply(200, { status: "matched" });
  for (let i = 0; i < 4; i++) await f.tick();
  expect(f.api.ui.status).toHaveBeenLastCalledWith(undefined);
  f.reply(403, { error: "remote_pane_required" });
  await f.tick();
  expect(f.api.ui.log).toHaveBeenCalledTimes(1);
  f.reply(403, { error: "native_session_required" });
  await f.tick();
  await f.tick();
  expect(f.api.ui.log).toHaveBeenCalledTimes(2);
  expect(f.api.ui.log.mock.calls[1]![0]).toContain("native_session_required");
});

test("helper distinguishes a refused loopback link and rereads replacement discovery without a restart", async () => {
  const f = await fixture();
  await f.start();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // A genuinely closed local port, not a simulated fetch exception.
  await f.link(`http://127.0.0.1:${port}`);
  await f.tick();
  expect(f.api.ui.log).toHaveBeenCalledTimes(1);
  expect(f.api.ui.log.mock.calls[0]![0]).toContain("connection was refused");
  expect(f.api.ui.log.mock.calls[0]![0]).not.toContain("authenticated link");
  await f.link(f.url);
  await f.tick();
  await f.tick();
  expect(f.api.ui.status).toHaveBeenLastCalledWith(undefined);
  expect(f.api.ui.log).toHaveBeenCalledTimes(1);
});

test("remote observer timeout and ordinary HTTP refusal remain distinct safe warning causes", async () => {
  const f = await fixture();
  await f.start();
  f.reply(503, { error: "remote_observation_timeout", detail: "server secret" });
  await f.tick();
  expect(f.api.ui.log.mock.calls[0]![0]).toContain("timed out during remote pane verification");
  expect(f.api.ui.log.mock.calls[0]![0]).toContain("HTTP 503, remote_observation_timeout");
  expect(f.api.ui.log.mock.calls[0]![0]).not.toContain("server secret");
  f.reply(401, { error: "authorization secret" });
  await f.tick();
  await f.tick();
  expect(f.api.ui.log.mock.calls[1]![0]).toContain("was refused (HTTP 401)");
  expect(f.api.ui.log.mock.calls[1]![0]).not.toContain("authorization secret");
});

test("a real stalled report times out with a bounded diagnostic and cannot display server secrets", async () => {
  const f = await fixture();
  await f.start();
  // Refusal headers arrive immediately; its stalled body still shares the
  // request deadline and must not swallow timeout into an ordinary HTTP error.
  f.reply(503, {}, true);
  await f.tick();
  expect(f.api.ui.log).toHaveBeenCalledTimes(1);
  expect(f.api.ui.log.mock.calls[0]![0]).toContain("timed out after 20s");
  expect(f.api.process.run.mock.calls.at(-1)![1].timeoutMs).toBe(25_000);
}, 30_000);

test("a real reset link is diagnosed separately and recovers through the same idle observer", async () => {
  const f = await fixture();
  await f.start();
  f.disconnect();
  await f.tick();
  expect(f.api.ui.log.mock.calls[0]![0]).toContain("lost its fleet link before a reply arrived");
  f.reply(200, { status: "matched" });
  await f.tick();
  await f.tick();
  expect(f.api.ui.status).toHaveBeenLastCalledWith(undefined);
});

test("a reset while reading a refusal body retains the transport cause", async () => {
  const f = await fixture();
  await f.start();
  f.reply(503, {});
  f.disconnectBody();
  await f.tick();
  expect(f.api.ui.log.mock.calls[0]![0]).toContain("lost its fleet link before a reply arrived");
  expect(f.api.ui.log.mock.calls[0]![0]).not.toContain("was refused (HTTP 503)");
});

test("native turns, in-flight tools and background agents hold probes without touching their connection", async () => {
  const f = await fixture();
  await f.start();
  await f.emit("turn.start", { turnId: "root-turn" });
  await f.tick();
  expect(f.reports).toHaveLength(1);
  await f.emit("turn.complete", { turnId: "root-turn" });
  await f.drain();
  expect(f.reports).toHaveLength(2);
  let finish = () => {};
  const result = { native: "result preserved" };
  const call = f.emit(
    "tool.call",
    { tool: "Bash", agentId: "child" },
    () => new Promise((resolve) => (finish = () => resolve(result))),
  );
  await f.tick();
  expect(f.reports).toHaveLength(2);
  finish();
  expect(await call).toBe(result);
  f.api.agent.list.mockResolvedValue([{ status: "running" }]);
  await f.tick();
  expect(f.reports).toHaveLength(2);
  f.api.agent.list.mockResolvedValue([]);
  await f.tick();
  expect(f.reports).toHaveLength(3);
});

test("a pending native catalog read cannot overlap a timer probe or report a replaced session", async () => {
  const f = await fixture();
  await f.start();
  let finish = () => {};
  f.api.tool.list.mockImplementation(() => new Promise((resolve) => (finish = () => resolve([]))));
  const tick = f.tick();
  await vi.waitFor(() => expect(f.api.tool.list).toHaveBeenCalledTimes(2));
  await f.tick();
  expect(f.api.mcp.connect).toHaveBeenCalledTimes(2);
  f.switch("owner-changed-session");
  finish();
  await tick;
  expect(f.reports).toHaveLength(1);
  f.api.tool.list.mockResolvedValue([]);
  await f.tick();
  expect(f.reports.at(-1)?.sessionId).toBe("owner-changed-session");
});

test("ending a session cancels observation; missing native APIs report a bounded failure", async () => {
  const f = await fixture();
  await f.start();
  f.api.mcp.connect.mockRejectedValue(new Error("native config secret"));
  await f.tick();
  expect(f.reports.at(-1)?.error).toBe(
    "Native Claude tool catalog unavailable: original mod API unsupported or disconnected",
  );
  expect(JSON.stringify(f.reports)).not.toContain("native config secret");
  await f.emit("session.end", { reason: "logout" });
  await f.tick();
  expect(f.reports).toHaveLength(2);
});

test("same-session lookup cannot bypass a post-await native session retirement", async () => {
  const f = await fixture();
  await f.emit("session.start", { isInteractive: true });
  let waiting = false;
  let finish = () => {};
  f.api.session.id = () =>
    new Promise((resolve) => {
      waiting = true;
      finish = () => resolve("original-session");
    });
  const observation = f.drain();
  await vi.waitFor(() => expect(waiting).toBe(true));
  await f.emit("session.end", { reason: "logout" });
  finish();
  await observation;
  expect(f.api.mcp.connect).not.toHaveBeenCalled();
  expect(f.api.process.run).not.toHaveBeenCalled();
  expect(f.reports).toHaveLength(0);
});

test("a downstream native completion error preserves its result and cannot wedge future observations", async () => {
  const f = await fixture();
  await f.start();
  await f.emit("turn.start", { turnId: "root-turn" });
  await expect(
    f.emit("turn.complete", { turnId: "root-turn" }, async () => {
      throw new Error("native downstream completion error");
    }),
  ).rejects.toThrow("native downstream completion error");
  await f.drain();
  expect(f.reports).toHaveLength(2);
});
