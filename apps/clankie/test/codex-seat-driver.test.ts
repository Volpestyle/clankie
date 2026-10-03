import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { startCodexAppServerSeat } from "../src/captain/codex-app-server.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  spawn.mockReset();
});

function fixture(persisted = false, missingRollout = "no rollout found", beforeResume?: () => Promise<void>) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let nativeLoaded = false;
  const id = "native-thread";
  spawn.mockImplementation((_command: string, args: string[]) => {
    const endpoint = args[args.indexOf("--listen") + 1]!;
    const http = createServer();
    const server = new WebSocketServer({ noServer: true });
    http.on("upgrade", (request, socket, head) => {
      server.handleUpgrade(request, socket, head, (socket) => server.emit("connection", socket));
    });
    http.listen(endpoint.slice("unix://".length));
    server.on("connection", (socket) =>
      socket.on("message", async (bytes) => {
        const message = JSON.parse(bytes.toString());
        requests.push(message);
        if (message.id === undefined) return;
        let result: unknown = {};
        const turn = { id: "turn-one", status: "inProgress", items: [] };
        if (message.method === "thread/loaded/list") result = { data: nativeLoaded ? [id] : [] };
        if (message.method === "thread/read") result = { thread: { id } };
        if (message.method === "thread/resume") {
          await beforeResume?.();
          if (!persisted) {
            socket.send(JSON.stringify({ id: message.id, error: { message: missingRollout } }));
            return;
          }
          result = { thread: { id, turns: [turn] } };
        }
        if (message.method === "turn/start") {
          persisted = true;
          result = { turn };
        }
        if (message.method === "turn/steer") result = { turnId: turn.id };
        socket.send(JSON.stringify({ id: message.id, result }));
      }),
    );
    const child = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      pid: 12345,
      exitCode: null,
      signalCode: null,
      unref: vi.fn(),
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("exit", 0));
        return true;
      }),
    });
    cleanup.push(async () => {
      for (const socket of server.clients) socket.terminate();
      server.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    return child;
  });
  return {
    requests,
    id,
    startView: async () => {
      nativeLoaded = true;
    },
  };
}

it("lets the native TUI create a fresh thread before input and subscribes after persistence", async () => {
  const f = fixture();
  const seat = await startCodexAppServerSeat({ cwd: "/tmp", startView: f.startView });
  cleanup.push(seat.close);
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true });
  expect(spawn.mock.results[0]?.value.unref).toHaveBeenCalledOnce();
  expect(seat.threadId).toBe(f.id);
  expect(f.requests.some((r) => r.method === "thread/start")).toBe(false);
  expect(f.requests.some((r) => r.method === "turn/start")).toBe(false);
  await expect(seat.send("first brief")).resolves.toEqual({ state: "started", turnId: "turn-one" });
  await expect(seat.send("follow-up")).resolves.toEqual({ state: "steered", turnId: "turn-one" });
  expect(f.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  expect(f.requests.find((r) => r.method === "turn/steer")?.params).toMatchObject({
    expectedTurnId: "turn-one",
    threadId: f.id,
  });
  await expect(seat.interrupt()).resolves.toBe(true);
});

it("treats Codex 0.159's empty-rollout resume error as not yet persisted", async () => {
  const f = fixture(
    false,
    "failed to read thread: thread-store internal error: failed to read session metadata /tmp/rollout.jsonl: rollout at /tmp/rollout.jsonl is empty",
  );
  const seat = await startCodexAppServerSeat({ cwd: "/tmp", startView: f.startView });
  cleanup.push(seat.close);
  await expect(seat.send("first brief")).resolves.toEqual({ state: "started", turnId: "turn-one" });
  expect(f.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
});

it.each([false, true])(
  "rechecks source after subscription before a native dispatch (persisted=%s)",
  async (persisted) => {
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    let releaseResume!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    let authorized = true;
    const f = fixture(persisted, "no rollout found", async () => {
      markWaiting();
      await release;
    });
    const seat = await startCodexAppServerSeat({ cwd: "/tmp", startView: f.startView });
    cleanup.push(seat.close);
    const delivery = seat.send("source-owned brief", async () => {
      if (!authorized) throw new Error("source grant revoked");
    });
    const assertion = expect(delivery).rejects.toThrow("source grant revoked");
    await waiting;
    authorized = false;
    releaseResume();
    await assertion;
    expect(f.requests.filter((r) => r.method === "turn/start" || r.method === "turn/steer")).toEqual([]);
  },
);

it("resumes the selected native thread and applies config to both clients without replay", async () => {
  const f = fixture(true);
  const config = ['plugins."clankie@clankie-seat".enabled=true'];
  const startView = vi.fn(async (_args: readonly string[]) => f.startView());
  const seat = await startCodexAppServerSeat({ cwd: "/tmp", config, resumeThreadId: f.id, startView });
  cleanup.push(seat.close);
  expect(spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["-c", config[0]]));
  expect(startView.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(["-c", config[0], "resume", f.id]));
  expect(f.requests.some((r) => r.method === "turn/start")).toBe(false);
  await expect(seat.send("operator event")).resolves.toEqual({ state: "steered", turnId: "turn-one" });
});

it("refuses a native view that resumes a different thread", async () => {
  const f = fixture(true);
  await expect(
    startCodexAppServerSeat({ cwd: "/tmp", resumeThreadId: "wrong", startView: f.startView }),
  ).rejects.toThrow("different thread");
});

it("allows operator hook review to abort before the native thread exists", async () => {
  const f = fixture();
  const controller = new AbortController();
  await expect(
    startCodexAppServerSeat({
      cwd: "/tmp",
      threadStartTimeoutMs: 600_000,
      signal: controller.signal,
      startView: async () => {
        setTimeout(() => controller.abort(new Error("native TUI exited")), 80);
      },
    }),
  ).rejects.toThrow("native TUI exited");
  expect(f.requests.some((r) => r.method === "turn/start")).toBe(false);
  expect(spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith("SIGTERM");
});

it("honors a caller's native thread discovery deadline and cleans up", async () => {
  fixture();
  await expect(
    startCodexAppServerSeat({ cwd: "/tmp", threadStartTimeoutMs: 0, startView: async () => {} }),
  ).rejects.toThrow("did not create its thread");
  expect(spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith("SIGTERM");
});

it("keeps the socket alive past discovery deadline and continues after native owner review", async () => {
  const f = fixture();
  let pending!: () => void;
  const waiting = new Promise<void>((resolve) => {
    pending = resolve;
  });
  const onServerStarted = vi.fn();
  const onServerStopped = vi.fn();
  const start = startCodexAppServerSeat({
    onServerStarted,
    onServerStopped,
    cwd: "/tmp",
    threadStartTimeoutMs: 0,
    startView: async () => {
      throw new Error("agent_not_ready: blocked");
    },
    onThreadPending: pending,
  });
  await waiting;
  expect(onServerStarted).toHaveBeenCalledExactlyOnceWith(12345);
  expect(onServerStopped).not.toHaveBeenCalled();
  expect(spawn.mock.results[0]?.value.kill).not.toHaveBeenCalled();
  expect(f.requests.some((r) => r.method === "turn/start")).toBe(false);
  // The fixture's native client creates its thread only after owner review.
  await f.startView();
  const seat = await start;
  cleanup.push(seat.close);
  await expect(seat.send("original brief")).resolves.toMatchObject({ state: "started" });
  expect(f.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  await seat.close();
  await seat.close();
  expect(onServerStopped).toHaveBeenCalledOnce();
});
