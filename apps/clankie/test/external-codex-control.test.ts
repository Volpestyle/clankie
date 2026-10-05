import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { codexProxyControl } from "../src/captain/external-codex-control.ts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import type { HerdrWatchRunner } from "../src/captain/herdr-watch.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function fixture(
  options: {
    status?: string;
    flags?: string[];
    id?: string;
    fail?: string;
    approval?: boolean;
    mismatchedReceipt?: boolean;
    beforeReply?: (method: string) => Promise<void>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "codex-proxy-test-"));
  const path = join(dir, "rpc.sock");
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const requests: { method?: string; params?: Record<string, unknown>; id?: number }[] = [];
  wss.on("connection", (socket) =>
    socket.on("message", async (bytes) => {
      const request = JSON.parse(bytes.toString());
      requests.push(request);
      if (request.id === undefined) return;
      await options.beforeReply?.(request.method);
      if (request.method === options.fail) {
        socket.close();
        return;
      }
      let result: unknown = {};
      if (request.method === "thread/read")
        result = {
          thread: {
            id: options.id ?? "thread",
            status: { type: options.status ?? "active", activeFlags: options.flags ?? [] },
          },
        };
      if (request.method === "thread/turns/list") result = { data: [{ id: "turn", status: "inProgress" }] };
      if (request.method === "turn/steer")
        result = { turnId: options.mismatchedReceipt ? "other-turn" : "turn" };
      if (options.approval)
        socket.send(
          JSON.stringify({ id: 9876, method: "item/commandExecution/requestApproval", params: {} }),
        );
      socket.send(JSON.stringify({ id: request.id, result }));
    }),
  );
  await new Promise<void>((resolve) => http.listen(path, resolve));
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => http.close(() => resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  const control = codexProxyControl(
    process.execPath,
    [
      "-e",
      "const s=require('node:net').connect(process.argv[1]);process.stdin.pipe(s).pipe(process.stdout);s.on('error',()=>process.exit(1));",
      path,
    ],
    1000,
  );
  return { control, requests };
}

describe("external Codex control", () => {
  it("steers the exact active turn over a raw proxy without resuming or answering approval", async () => {
    const { control, requests } = await fixture({ approval: true });
    expect(await control("thread", "message & draft")).toEqual({ outcome: "delivered", state: "steered" });
    expect(requests.filter((r) => r.method === "turn/steer")).toEqual([
      {
        id: 4,
        method: "turn/steer",
        params: {
          threadId: "thread",
          expectedTurnId: "turn",
          input: [{ type: "text", text: "message & draft", text_elements: [] }],
        },
      },
    ]);
    expect(
      requests.some((r) => r.id === 9876 || r.method === "thread/resume" || r.method === "turn/start"),
    ).toBe(false);
  });
  it.each([{ status: "notLoaded" }, { status: "idle" }, { id: "another-thread" }])(
    "permits queue without touching an inactive or mismatched thread: %j",
    async (options) => {
      const { control, requests } = await fixture(options);
      expect(await control("thread", "hello")).toBeUndefined();
      expect(requests.some((r) => r.method === "turn/steer")).toBe(false);
    },
  );
  it("keeps owner approval pending", async () => {
    const { control, requests } = await fixture({ flags: ["waitingOnApproval"] });
    expect((await control("thread", "hello"))?.outcome).toBe("undelivered");
    expect(requests.some((r) => r.method === "turn/steer")).toBe(false);
  });
  it.each(["off", "throws"])(
    "refuses a %s authority guard after a deferred native turn read without steering",
    async (mode) => {
      let readStarted!: () => void;
      const reading = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      let finishRead!: () => void;
      const prepared = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      let authorized = true;
      const beforeDispatch = vi.fn(async () => {
        if (mode === "throws" && !authorized) throw new Error("authority lookup failed");
        return authorized;
      });
      const { control, requests } = await fixture({
        beforeReply: async (method) => {
          if (method === "thread/turns/list") {
            readStarted();
            await prepared;
          }
        },
      });
      const sending = control("thread", "peer context", undefined, undefined, beforeDispatch);
      await reading;
      authorized = false;
      finishRead();
      expect(await sending).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
      expect(beforeDispatch).toHaveBeenCalledOnce();
      expect(
        requests.some((request) => request.method === "turn/steer" || request.method === "turn/start"),
      ).toBe(false);
    },
  );
  it("reports uncertainty after dispatch without permitting queue fallback", async () => {
    const { control } = await fixture({ fail: "turn/steer" });
    expect((await control("thread", "hello"))?.outcome).toBe("unconfirmed");
  });
  it("permits queue on a read-only disconnect", async () => {
    const { control } = await fixture({ fail: "thread/read" });
    expect(await control("thread", "hello")).toBeUndefined();
  });
  it("handles an unavailable executable before delivery", async () => {
    expect(await codexProxyControl("/nonexistent/codex", [], 100)("thread", "hello")).toBeUndefined();
  });
});

it("uses Herdr's daemon session identity and never queues an uncertain steer", async () => {
  const codexQueue = vi.fn(async () => true);
  const runner = {
    resolveTerminal: async () => ({
      paneId: "pane",
      agent: "codex",
      session: { kind: "id", value: "thread", source: "codex" },
    }),
    paneProcesses: async () => [{ pid: 123, name: "codex", argv: ["codex"] }],
    openFiles: async () => "",
    codexQueue,
    codexControl: vi.fn(async () => ({ outcome: "unconfirmed" as const, detail: "lost receipt" })),
  } as unknown as HerdrWatchRunner;
  expect((await createFleetSeatControl(runner, new Map()).deliverToSeat("pane", "hello")).outcome).toBe(
    "unconfirmed",
  );
  expect(codexQueue).not.toHaveBeenCalled();
  runner.codexControl = async () => undefined;
  expect(await createFleetSeatControl(runner, new Map()).deliverToSeat("pane", "hello")).toMatchObject({
    outcome: "delivered",
    state: "queued",
    detail: expect.stringContaining("until the current Codex turn ends"),
  });
});

it("does not retry a mismatched steering receipt", async () => {
  const { control } = await fixture({ mismatchedReceipt: true });
  expect((await control("thread", "hello"))?.outcome).toBe("unconfirmed");
});

it("passes only the selected pane's explicit Unix endpoint", async () => {
  const codexControl = vi.fn(async () => ({ outcome: "delivered" as const, state: "steered" as const }));
  const codexQueue = vi.fn(async () => true);
  const runner = {
    resolveTerminal: async () => ({
      paneId: "pane",
      agent: "codex",
      session: { kind: "id", value: "thread", source: "codex" },
    }),
    paneProcesses: async () => [
      { pid: 123, name: "codex", argv: ["codex", "--remote", "unix:///owned/socket"] },
    ],
    openFiles: async () => "",
    codexQueue,
    codexControl,
  } as unknown as HerdrWatchRunner;
  expect((await createFleetSeatControl(runner, new Map()).deliverToSeat("pane", "hello")).outcome).toBe(
    "delivered",
  );
  expect(codexControl).toHaveBeenCalledWith("thread", "hello", undefined, "unix:///owned/socket");
  expect(codexQueue).not.toHaveBeenCalled();
});

it("refuses a changed pane session before either proxy or queue", async () => {
  const codexControl = vi.fn();
  const codexQueue = vi.fn();
  const runner = {
    resolveTerminal: async () => ({
      paneId: "pane",
      agent: "codex",
      session: { kind: "id", value: "old-thread", source: "codex" },
    }),
    paneProcesses: async () => [{ pid: 123, name: "codex" }],
    openFiles: async () => "n/home/.codex/sessions/rollout-date-11111111-1111-1111-1111-111111111111.jsonl",
    codexQueue,
    codexControl,
  } as unknown as HerdrWatchRunner;
  expect((await createFleetSeatControl(runner, new Map()).deliverToSeat("pane", "hello")).outcome).toBe(
    "undelivered",
  );
  expect(codexControl).not.toHaveBeenCalled();
  expect(codexQueue).not.toHaveBeenCalled();
});

it.each([
  { state: "steered", daemon: true },
  { state: "queued", daemon: true },
  { state: "queued", daemon: false },
] as const)(
  "delivers to the parent Codex session with child rollouts open: %j",
  async ({ state, daemon }) => {
    const parent = "01a0ffca-ce02-7cc1-9c33-55318fe44667";
    const codexControl = vi.fn(async () =>
      state === "steered" ? { outcome: "delivered" as const, state } : undefined,
    );
    const codexQueue = vi.fn(async () => true);
    const runner = {
      resolveTerminal: async () => ({
        paneId: "w3Z:p2",
        agent: "codex",
        session: { kind: "id", value: parent, source: "herdr:codex" },
      }),
      paneProcesses: async () => [
        {
          pid: 16676,
          name: "codex",
          argv: ["codex", "resume", parent, ...(daemon ? [] : ["--no-daemon"])],
        },
      ],
      openFiles: async () =>
        [
          "n/child-home/sessions/rollout-child-01a103b0-1111-7111-9111-111111111111.jsonl",
          `n/parent-home/sessions/rollout-parent-${parent}.jsonl`,
          "n/child-home/sessions/rollout-child-01a103b1-1111-7111-9111-111111111111.jsonl",
        ].join("\n"),
      codexQueue,
      codexControl,
    } as unknown as HerdrWatchRunner;
    expect(await createFleetSeatControl(runner, new Map()).deliverToSeat("w3Z:p2", "hello")).toMatchObject({
      outcome: "delivered",
      state,
    });
    if (daemon) expect(codexControl).toHaveBeenCalledWith(parent, "hello", "/parent-home", undefined);
    else expect(codexControl).not.toHaveBeenCalled();
    if (state === "queued") expect(codexQueue).toHaveBeenCalledWith(parent, "hello", "/parent-home");
    else expect(codexQueue).not.toHaveBeenCalled();
  },
);

it("uses the remote pane's reported parent without inspecting local rollouts", async () => {
  const parent = "01a0ffca-ce02-7cc1-9c33-55318fe44667";
  const inspect = vi.fn();
  const local = vi.fn();
  const queue = vi.fn(async () => true);
  const native = vi.fn(async () => undefined);
  const runner = {
    resolveTerminal: async () => ({
      paneId: "pc/w3Z:p2",
      agent: "codex",
      session: { kind: "id", value: parent, source: "herdr:codex" },
    }),
    paneProcesses: inspect,
    openFiles: inspect,
    codexControl: local,
    codexQueue: local,
  } as unknown as HerdrWatchRunner;
  const select = vi.fn(() => native);
  expect(
    await createFleetSeatControl(runner, new Map(), undefined, queue, select).deliverToSeat(
      "pc/w3Z:p2",
      "hello",
    ),
  ).toMatchObject({ outcome: "delivered", state: "queued" });
  expect(select).toHaveBeenCalledWith("pc", "pc/w3Z:p2");
  expect(native).toHaveBeenCalledWith(parent, "hello");
  expect(queue).toHaveBeenCalledWith("pc", parent, "hello", undefined, "pc/w3Z:p2");
  expect(inspect).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
});

it("never requeues an uncertain remote dispatch or falls back to a local server", async () => {
  const queue = vi.fn();
  const local = vi.fn();
  const runner = {
    resolveTerminal: async () => ({
      paneId: "pc/w1:p1",
      agent: "codex",
      session: { kind: "id", value: "thread", source: "codex" },
    }),
    codexControl: local,
  } as unknown as HerdrWatchRunner;
  const control = createFleetSeatControl(runner, new Map(), undefined, queue, () => async () => ({
    outcome: "unconfirmed",
    detail: "SSH dropped",
  }));
  expect((await control.deliverToSeat("pc/w1:p1", "hello")).outcome).toBe("unconfirmed");
  expect(queue).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
});

it("does not substitute the default daemon for an unsupported explicit endpoint", async () => {
  expect(
    await codexProxyControl("/nonexistent/codex")("thread", "hello", undefined, "wss://elsewhere"),
  ).toBeUndefined();
});

it("does not guess the default server when process inspection is unavailable", async () => {
  const native = vi.fn();
  const queue = vi.fn(async () => true);
  const runner = {
    resolveTerminal: async () => ({
      paneId: "pane",
      agent: "codex",
      session: { kind: "id", value: "thread", source: "codex" },
    }),
    paneProcesses: async () => {
      throw new Error("disconnected");
    },
    openFiles: async () => "",
    codexControl: native,
    codexQueue: queue,
  } as unknown as HerdrWatchRunner;
  expect(await createFleetSeatControl(runner, new Map()).deliverToSeat("pane", "hello")).toMatchObject({
    state: "queued",
  });
  expect(native).not.toHaveBeenCalled();
  expect(queue).toHaveBeenCalledOnce();
});

it("never substitutes a shared daemon for a --no-daemon TUI", async () => {
  const native = vi.fn();
  const queue = vi.fn(async () => true);
  const runner = {
    resolveTerminal: async () => ({
      paneId: "pane",
      agent: "codex",
      session: { kind: "id", value: "thread", source: "codex" },
    }),
    paneProcesses: async () => [
      { pid: 123, name: "codex", argv: ["codex", "resume", "thread", "--no-daemon"] },
    ],
    openFiles: async () => "",
    codexControl: native,
    codexQueue: queue,
  } as unknown as HerdrWatchRunner;
  expect(await createFleetSeatControl(runner, new Map()).deliverToSeat("pane", "hello")).toMatchObject({
    state: "queued",
  });
  expect(native).not.toHaveBeenCalled();
  expect(queue).toHaveBeenCalledOnce();
});
