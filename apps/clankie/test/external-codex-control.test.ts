import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { codexProxyControl, codexSocketSettled } from "../src/captain/external-codex-control.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function fixture(
  options: {
    status?: string;
    turns?: () => unknown[];
    flags?: string[];
    id?: string;
    fail?: string;
    approval?: boolean;
    mismatchedReceipt?: boolean;
    beforeReply?: (method: string) => Promise<void>;
    turnPage?: (params: Record<string, unknown>) => unknown;
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
            turns: options.turns?.() ?? [],
          },
        };
      if (request.method === "thread/turns/list") {
        const all = options.turns?.() as Record<string, unknown>[] | undefined;
        const start = Number(request.params.cursor ?? 0);
        const limit = request.params.limit ?? 100;
        const page = all?.slice(start, start + limit);
        result = options.turnPage?.(request.params) ?? {
          data: page?.map((turn) => ({
            ...turn,
            ...(request.params.itemsView === "notLoaded" ? { items: [] } : {}),
          })) ?? [{ id: "turn", status: "inProgress" }],
          nextCursor: all && start + limit < all.length ? String(start + limit) : null,
        };
      }
      if (request.method === "thread/queue/add")
        result = {
          queuedSubmission: {
            id: "queue-1",
            clientUserMessageId: request.params.clientUserMessageId,
          },
        };
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
  return {
    control,
    requests,
    connect: async () => new WebSocket(`ws+unix://${path}:/`),
    queue: codexProxyControl(
      process.execPath,
      [
        "-e",
        "const s=require('node:net').connect(process.argv[1]);process.stdin.pipe(s).pipe(process.stdout);s.on('error',()=>process.exit(1));",
        path,
      ],
      1000,
      "queue",
    ),
  };
}

describe("external Codex control", () => {
  it("steers the exact active turn over a raw proxy without resuming or answering approval", async () => {
    const { control, requests } = await fixture({ approval: true });
    expect(await control("thread", "message & draft")).toEqual({
      outcome: "delivered",
      state: "steered",
      messageId: "turn",
    });
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
  it("names why a queue sent nothing", async () => {
    const missing = await codexProxyControl("/nonexistent/codex", [], 100, "queue")("thread", "hello");
    expect(missing).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
    expect(missing?.detail).toMatch(/ENOENT/u);
    const { queue, requests } = await fixture({ status: "notLoaded" });
    expect((await queue("thread", "hello"))?.detail).toBe(
      "Codex queue unavailable (Codex reports this session as notLoaded); nothing was sent.",
    );
    expect(requests.some((request) => request.method === "thread/queue/add")).toBe(false);
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
    expect(await createFleetSeatControl(runner, new Map()).deliverToSeat("w3Z:p2", "hello")).toMatchObject(
      daemon ? { outcome: "delivered", state } : { outcome: "undelivered" },
    );
    if (daemon) expect(codexControl).toHaveBeenCalledWith(parent, "hello", "/parent-home", undefined);
    else expect(codexControl).not.toHaveBeenCalled();
    if (state === "queued" && daemon)
      expect(codexQueue).toHaveBeenCalledWith(parent, "hello", "/parent-home");
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
    outcome: "undelivered",
  });
  expect(native).not.toHaveBeenCalled();
  expect(queue).not.toHaveBeenCalled();
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
    outcome: "undelivered",
  });
  expect(native).not.toHaveBeenCalled();
  expect(queue).not.toHaveBeenCalled();
});

it("returns the exact native queue input identity without waiting for its turn", async () => {
  const f = await fixture({ status: "idle" });
  const delivered = await f.queue("thread", "fast queued turn");
  const sent = f.requests.find((r) => r.method === "thread/queue/add")!;
  expect(delivered).toEqual({
    outcome: "delivered",
    state: "queued",
    // Held in Codex's queue: acknowledged, not yet read.
    deliveryStage: "delivered",
    messageId: `codex-input:${String(sent.params!.clientUserMessageId)}`,
  });
  expect(f.requests.filter((r) => r.method === "thread/queue/add")).toHaveLength(1);
});

it("recovers a fast completed input after watch admission and excludes another input's completion", async () => {
  const turns: unknown[] = [
    {
      id: "turn-A",
      status: "completed",
      items: [
        { type: "userMessage", clientId: "input-A", content: [{ type: "text", text: "same marker" }] },
        { type: "agentMessage", text: "A done" },
      ],
    },
  ];
  const f = await fixture({ status: "idle", turns: () => turns });
  const dir = await mkdtemp(join(tmpdir(), "local37-watch-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "watches.json");
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term-codex",
    title: "Owned test seat",
    agent: "codex",
    status: "done",
    session: { kind: "id", source: "herdr:codex", value: "thread" },
  };
  new HireOwners(`${path}.owners.json`).bind(
    agent.paneId,
    { conversationId: "lead" },
    agent.terminalId,
    undefined,
    occupantIdForHerdrSession(agent.session!),
  );
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: vi.fn(async () => {
      throw new Error("Pane status must not settle a message watch");
    }),
    paneProcesses: async () => [
      { pid: 100, name: "codex", argv: ["codex", "--remote", "unix:///fixture.sock"] },
    ],
    codexSettled: (session, id, signal, _endpoint, _home, guard) =>
      codexSocketSettled(f.connect, session, id, signal, guard, 5),
  };
  const wakes: string[] = [];
  const store = new HerdrWatchStore(path, { runner });
  store.start(async (_lead, prompt, _origin, guard) => {
    await guard?.();
    wakes.push(prompt);
  });
  try {
    const a = await store.watch("lead", agent.paneId, "A", undefined, undefined, "codex-input:input-A");
    expect(a).toMatchObject({ outcome: "watching", messageId: "codex-input:input-A" });
    await vi.waitFor(() => expect(wakes).toHaveLength(1));
    expect(wakes[0]).toContain("native turn: turn-A");
    const b = await store.watch("lead", agent.paneId, "B", undefined, undefined, "codex-input:input-B");
    expect(b).toMatchObject({ outcome: "watching", messageId: "codex-input:input-B" });
    // Wait until the B observer has actually read A's retained completion.
    await vi.waitFor(() =>
      expect(f.requests.filter((r) => r.method === "thread/turns/list").length).toBeGreaterThan(3),
    );
    expect(wakes).toHaveLength(1);
    turns.push({
      id: "turn-B",
      status: "completed",
      items: [
        { type: "userMessage", clientId: "input-B", content: [{ type: "text", text: "same marker" }] },
        { type: "agentMessage", text: "B done" },
      ],
    });
    await vi.waitFor(() => expect(wakes).toHaveLength(2));
    expect(wakes[1]).toContain("native turn: turn-B");
    expect(wakes[1]).not.toContain("A done");
    expect(
      await store.watch("lead", agent.paneId, "B again", undefined, undefined, "codex-input:input-B"),
    ).toMatchObject({
      outcome: "settled_for_message",
      messageId: "codex-input:input-B",
      completion: { type: "turn_completed", nativeTurnId: "turn-B", text: "B done" },
    });
    expect(wakes).toHaveLength(2);
    expect(runner.wait).not.toHaveBeenCalled();
    expect(
      f.requests.every((r) =>
        ["initialize", "initialized", "thread/turns/list", "thread/read"].includes(r.method!),
      ),
    ).toBe(true);
  } finally {
    store.close();
  }
});

it("aborts a pending exact native input wait without a completion or another send", async () => {
  const f = await fixture({ turns: () => [] });
  const abort = new AbortController();
  const waiting = codexSocketSettled(
    f.connect,
    "thread",
    "codex-input:pending",
    abort.signal,
    async () => {},
    5,
  );
  const rejected = expect(waiting).rejects.toThrow();
  await vi.waitFor(() => expect(f.requests.some((r) => r.method === "thread/turns/list")).toBe(true));
  abort.abort(new Error("watch canceled"));
  await rejected;
  expect(f.requests.some((r) => ["turn/start", "turn/steer", "thread/queue/add"].includes(r.method!))).toBe(
    false,
  );
});

it("polls shells without rereading unchanged history and recovers a later merged input with its complete result", async () => {
  const turns: { id: string; status: string; items: { type: string; clientId?: string; text?: string }[] }[] =
    Array.from({ length: 123 }, (_, index) => ({
      id: `old-${index}`,
      status: "completed",
      items: [{ type: "userMessage", clientId: `other-${index}` }],
    }));
  const f = await fixture({ turns: () => turns, approval: true });
  const abort = new AbortController();
  const waiting = codexSocketSettled(
    f.connect,
    "thread",
    "codex-input:target",
    abort.signal,
    async () => {},
    5,
  );
  const fullReads = () => f.requests.filter((r) => r.method === "thread/read");
  const shellReads = () => f.requests.filter((r) => r.params?.itemsView === "notLoaded");
  try {
    await vi.waitFor(() => expect(shellReads().length).toBeGreaterThanOrEqual(8));
    expect(fullReads()).toHaveLength(1);
    expect(shellReads().some((r) => r.params?.cursor === "100")).toBe(true);
    expect(fullReads()[0]?.params).toEqual({ threadId: "thread", includeTurns: true });
    turns.push({
      id: "merged",
      status: "completed",
      items: [
        { type: "userMessage", clientId: "first-input" },
        { type: "agentMessage", text: "first result" },
        { type: "userMessage", clientId: "target" },
        { type: "agentMessage", text: "last result" },
      ],
    });
    expect(await waiting).toMatchObject({
      nativeTurnId: "merged",
      ok: true,
      text: "first result\nlast result",
    });
    expect(
      f.requests.every((r) =>
        ["initialize", "initialized", "thread/turns/list", "thread/read"].includes(r.method!),
      ),
    ).toBe(true);
    expect(f.requests.some((r) => r.id === 9876)).toBe(false);
  } finally {
    abort.abort();
    await waiting.catch(() => {});
  }
});

it("freshly audits unchanged metadata without letting an ambiguous queued identity settle", async () => {
  const turns = Array.from({ length: 12 }, (_, index) => ({
    id: `turn-${index}`,
    status: "completed",
    items: [{ type: "userMessage", clientId: index === 0 || index === 11 ? "target" : "other" }],
  }));
  const f = await fixture({ turns: () => turns });
  const abort = new AbortController();
  let settled = false;
  const waiting = codexSocketSettled(
    f.connect,
    "thread",
    "codex-input:target",
    abort.signal,
    async () => {},
    5,
    100,
  ).then((event) => {
    settled = true;
    return event;
  });
  try {
    await vi.waitFor(() =>
      expect(f.requests.filter((r) => r.method === "thread/read").length).toBeGreaterThanOrEqual(2),
    );
    expect(settled).toBe(false);
    // Same IDs/statuses: only a fresh full-item audit can discover this change.
    turns[0]!.items[0]!.clientId = "different";
    expect(await waiting).toMatchObject({ nativeTurnId: "turn-11" });
  } finally {
    abort.abort();
    await waiting.catch(() => {});
  }
});

it.each(["cursor", "duplicate", "oversized", "malformed"])(
  "refuses %s history pages without settling or sending",
  async (kind) => {
    const f = await fixture({
      turnPage: () => ({
        data:
          kind === "malformed"
            ? [{ id: "a" }]
            : Array.from({ length: kind === "oversized" ? 101 : kind === "duplicate" ? 2 : 1 }, (_, i) => ({
                id: kind === "duplicate" ? "same" : String(i),
                status: "completed",
                items: [],
              })),
        nextCursor: kind === "cursor" ? "repeated" : null,
      }),
    });
    await expect(
      codexSocketSettled(f.connect, "thread", "a", new AbortController().signal, async () => {}, 5),
    ).rejects.toThrow();
    expect(
      f.requests.every((r) =>
        ["initialize", "initialized", "thread/turns/list", "thread/read"].includes(r.method!),
      ),
    ).toBe(true);
  },
);

it("rechecks authority after a full read before publishing a retained completion", async () => {
  let authorized = true;
  const f = await fixture({
    turns: () => [{ id: "done", status: "completed", items: [] }],
    beforeReply: async (method) => {
      if (method === "thread/read") authorized = false;
    },
  });
  await expect(
    codexSocketSettled(
      f.connect,
      "thread",
      "done",
      new AbortController().signal,
      async () => {
        if (!authorized) throw new Error("seat replaced");
      },
      5,
    ),
  ).rejects.toThrow("seat replaced");
});

it("automatically watches a queued turn that completed before its send receipt returned", async () => {
  const turns: unknown[] = [];
  const f = await fixture({
    status: "idle",
    turns: () => turns,
    beforeReply: async (method) => {
      if (method !== "thread/queue/add") return;
      const sent = f.requests.findLast((r) => r.method === method)!;
      turns.push({
        id: "fast-turn",
        status: "completed",
        items: [
          { type: "userMessage", clientId: sent.params!.clientUserMessageId },
          { type: "agentMessage", text: "already finished" },
        ],
      });
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "local37-auto-watch-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "watches.json");
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term-codex",
    title: "Owned test seat",
    agent: "codex",
    status: "done",
    session: { kind: "id", source: "herdr:codex", value: "thread" },
  };
  new HireOwners(`${path}.owners.json`).bind(
    agent.paneId,
    { conversationId: "lead" },
    agent.terminalId,
    undefined,
    occupantIdForHerdrSession(agent.session!),
  );
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => agent,
    paneProcesses: async () => [
      { pid: 100, name: "codex", argv: ["codex", "--remote", "unix:///fixture.sock"] },
    ],
    openFiles: async () => "",
    codexQueue: async (...args) => (await f.queue(...args))!,
    codexSettled: (session, id, signal, _endpoint, _home, guard) =>
      codexSocketSettled(f.connect, session, id, signal, guard, 5),
  };
  const store = new HerdrWatchStore(path, { runner });
  const wakes: string[] = [];
  store.start(async (_lead, prompt, _origin, guard) => {
    await guard?.();
    wakes.push(prompt);
  });
  try {
    const delivered = await store.deliverToSeat(agent.terminalId, "fast");
    expect(delivered).toMatchObject({
      outcome: "delivered",
      state: "queued",
      messageId: expect.stringMatching(/^codex-input:/),
    });
    if (delivered.outcome !== "delivered") throw new Error("fixture delivery failed");
    await vi.waitFor(() => expect(wakes).toHaveLength(1));
    expect(wakes[0]).toContain(`Settled native message: ${delivered.messageId}; native turn: fast-turn`);
    expect(
      await store.watch(
        "lead",
        agent.paneId,
        "read completed receipt",
        undefined,
        undefined,
        delivered.messageId,
      ),
    ).toMatchObject({
      outcome: "settled_for_message",
      messageId: delivered.messageId,
      completion: { nativeTurnId: "fast-turn", text: "already finished" },
    });
    expect(wakes).toHaveLength(1);
    expect(f.requests.filter((r) => r.method === "thread/queue/add")).toHaveLength(1);
  } finally {
    store.close();
  }
});
