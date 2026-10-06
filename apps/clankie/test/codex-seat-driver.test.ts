import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { startCodexAppServerSeat } from "../src/captain/codex-app-server.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  spawn.mockReset();
});

function fixture(
  persisted = false,
  missingRollout = "no rollout found",
  beforeResume?: () => Promise<void>,
  receipt?: { winner?: Record<string, { answers: string[] }>; omitOutput?: boolean },
) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let nativeLoaded = false;
  const id = "native-thread";
  let peer: WebSocket | undefined;
  let nativeAnswer: Record<string, { answers: string[] }> | undefined;
  spawn.mockImplementation((_command: string, args: string[]) => {
    const endpoint = args[args.indexOf("--listen") + 1]!;
    const http = createServer();
    const server = new WebSocketServer({ noServer: true });
    http.on("upgrade", (request, socket, head) => {
      server.handleUpgrade(request, socket, head, (socket) => server.emit("connection", socket));
    });
    http.listen(endpoint.slice("unix://".length));
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", async (bytes) => {
        const message = JSON.parse(bytes.toString());
        requests.push(message);
        if (message.id === undefined) return;
        if (message.id === "question-1" && message.method === undefined) {
          if (!receipt?.omitOutput) nativeAnswer = receipt?.winner ?? message.result.answers;
          socket.send(
            JSON.stringify({
              method: "serverRequest/resolved",
              params: { threadId: id, requestId: "question-1" },
            }),
          );
          return;
        }
        let result: unknown = {};
        const turn = {
          id: "turn-one",
          status: "inProgress",
          items: nativeAnswer
            ? [
                {
                  type: "functionCallOutput",
                  id: "call1",
                  name: "request_user_input",
                  output: JSON.stringify({ answers: nativeAnswer }),
                },
              ]
            : [],
        };
        if (message.method === "thread/loaded/list") result = { data: nativeLoaded ? [id] : [] };
        if (message.method === "thread/read") result = { thread: { id, turns: [turn] } };
        if (message.method === "thread/turns/list") {
          expect(message.params).toEqual({
            threadId: id,
            limit: 1,
            sortDirection: "desc",
            itemsView: "full",
          });
          result = { data: persisted ? [{ ...turn, items: [] }] : [] };
        }
        if (message.method === "thread/resume") {
          await beforeResume?.();
          if (!persisted) {
            socket.send(JSON.stringify({ id: message.id, error: { message: missingRollout } }));
            return;
          }
          result = { thread: { id, turns: message.params.excludeTurns ? [] : [turn] } };
        }
        if (message.method === "turn/start") {
          persisted = true;
          result = { turn };
        }
        if (message.method === "turn/steer") result = { turnId: turn.id };
        socket.send(JSON.stringify({ id: message.id, result }));
      });
    });
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
    ask: () =>
      peer!.send(
        JSON.stringify({
          id: "question-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: id,
            turnId: "turn-one",
            itemId: "call1",
            isBlocking: true,
            questions: [
              {
                id: "docs",
                header: "Docs",
                question: "Which worktree?",
                isOther: true,
                isSecret: false,
                options: null,
              },
            ],
          },
        }),
      ),
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
  expect(f.requests.filter((r) => r.method === "thread/turns/list")).toHaveLength(1);
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
  expect(f.requests.filter((r) => r.method === "turn/start")).toHaveLength(0);
  expect(f.requests.filter((r) => r.method === "thread/turns/list")).toHaveLength(1);
  expect(f.requests.find((r) => r.method === "turn/steer")?.params).toMatchObject({
    expectedTurnId: "turn-one",
    threadId: f.id,
  });
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

it.each([
  "agent_not_ready: blocked",
  '{"error":{"code":"trust_required","message":"3 hooks are new or changed"}}',
])(
  "keeps the socket alive past discovery deadline after %s and continues after native owner review",
  async (failure) => {
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
        throw new Error(failure);
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
  },
);

it.each([
  { receipt: {}, outcome: "answered" },
  { receipt: { winner: { docs: { answers: ["owner choice"] } } }, outcome: "refused" },
  { receipt: { omitOutput: true }, outcome: "unconfirmed" },
])(
  "verifies the native winning answer instead of guessing from a resolved notification ($outcome)",
  async ({ receipt, outcome }) => {
    const f = fixture(false, "no rollout found", undefined, receipt);
    const events = vi.fn();
    const seat = await startCodexAppServerSeat({ cwd: "/tmp", startView: f.startView, onEvent: events });
    cleanup.push(seat.close);
    await seat.send("initial brief");
    f.ask();
    await vi.waitFor(() =>
      expect(events).toHaveBeenCalledWith(expect.objectContaining({ method: "item/tool/requestUserInput" })),
    );
    const result = await seat.answerQuestion!({
      requestId: "question-1",
      answers: { docs: { answers: ["lead choice"] } },
    });
    expect(result).toMatchObject({ outcome });
    if (outcome === "answered") expect(result).toHaveProperty("deliveryStage", "responded");
    if (outcome === "refused")
      expect(result).toHaveProperty("detail", expect.stringContaining("first native answer won"));
    expect(f.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
    expect(f.requests.filter((r) => r.method === "turn/steer")).toHaveLength(0);
    expect(
      f.requests.filter(
        (r) => r.method === undefined && (r as unknown as { id: string }).id === "question-1",
      ),
    ).toHaveLength(1);
    expect(
      await seat.answerQuestion!({ requestId: "question-1", answers: { docs: { answers: ["retry"] } } }),
    ).toMatchObject({ outcome: "refused" });
  },
);
