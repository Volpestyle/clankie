import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { startCodexAppServerSeat } from "../../src/captain/codex-app-server.ts";

assert.equal(typeof global.gc, "function");
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const threadId = "retention-root";
let peer;
let pendingStart;
let idleTurn;
let deliveries = [];
let audits = [];
let references = [];
let started = 0;
let seat;
const methods = [];
const turn = (id, status = "completed") => ({
  id,
  status,
  items: [{ id: `${id}-message`, type: "agentMessage", text: `final:${id}:` + "native 🌻".repeat(8192) }],
  error: status === "failed" ? { message: "native failure detail" } : null,
});
const send = (method, params) => peer.send(JSON.stringify({ method, params }));
const wait = async (check) => {
  for (let i = 0; i < 2000 && !check(); i++) await delay(1);
  assert.ok(check(), "native protocol observation did not arrive");
};
const collect = async () => {
  for (let i = 0; i < 4; i++) {
    await delay(0);
    global.gc();
  }
  return references.filter((ref) => ref.deref() !== undefined).length;
};
server.on("connection", (socket) => {
  peer = socket;
  socket.on("message", (bytes) => {
    const request = JSON.parse(String(bytes));
    if (request.id === undefined) return;
    methods.push(request.method);
    if (request.method === "turn/start") {
      pendingStart = { id: request.id, socket };
      return;
    }
    const result =
      request.method === "thread/loaded/list"
        ? { data: [threadId], nextCursor: null }
        : request.method === "thread/read"
          ? { thread: { id: threadId, turns: request.params.includeTurns && idleTurn ? [idleTurn] : [] } }
          : request.method === "thread/resume"
            ? { thread: { id: threadId, turns: [] } }
            : request.method === "thread/turns/list"
              ? { data: [] }
              : {};
    socket.send(JSON.stringify({ id: request.id, result }));
  });
});
try {
  seat = await startCodexAppServerSeat({
    cwd: process.cwd(),
    resumeThreadId: threadId,
    startView: async () => {},
    server: async () => ({
      endpoint: "unix:///owned-protocol-fixture",
      connect: async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
        await once(socket, "open");
        return socket;
      },
      failure: () => undefined,
      output: () => "",
      close: async () => {},
    }),
    policy: {
      connected: async () => {},
      beforeTurn: async () => {},
      audit: async (event) => {
        if (event.method === "turn/completed")
          audits.push({ id: event.params.turn.id, text: event.params.turn.items?.[0]?.text });
      },
      failed: async (error) => {
        throw error;
      },
    },
    onEvent: (event) => {
      if (event.method === "turn/started") started++;
      if (event.method !== "turn/completed") return;
      const completed = event.params.turn;
      if (completed.items) references.push(new WeakRef(completed.items));
      deliveries.push({
        id: completed.id,
        status: completed.status,
        text: completed.items?.[0]?.text,
        error: completed.error,
      });
    },
  });

  for (let i = 0; i < 80; i++) {
    send("turn/completed", { threadId, turn: turn(`ordinary-${i}`) });
    await wait(() => deliveries.length === i + 1);
  }
  const ordinaryAlive = await collect();
  assert.equal(ordinaryAlive, 0, "settled history retains completed native item arrays");
  send("turn/started", { threadId, turn: { id: "ordinary-79" } });
  await wait(() => started === 1);
  assert.deepEqual(
    await seat.stopTask(async () => {
      throw new Error("completed turn cannot be interrupted");
    }),
    { outcome: "already_finished" },
  );
  const races = [];
  for (const status of ["completed", "failed", "interrupted"]) {
    references = [];
    deliveries = [];
    audits = [];
    pendingStart = undefined;
    const sending = seat.send("fixture input");
    await wait(() => pendingStart !== undefined);
    const native = turn(`early-${status}`, status);
    send("turn/completed", { threadId, turn: native });
    await wait(() => deliveries.length === 1);
    const pendingAlive = await collect();
    assert.equal(pendingAlive, 1, "early completion must survive until the start reply");
    pendingStart.socket.send(JSON.stringify({ id: pendingStart.id, result: { turn: { id: native.id } } }));
    assert.equal((await sending).turnId, native.id);
    await wait(() => deliveries.length === 2 && audits.length === 2);
    for (const delivery of deliveries) {
      assert.equal(delivery.text, native.items[0].text);
      assert.equal(delivery.status, status);
      assert.deepEqual(delivery.error, native.error);
    }
    assert.ok(
      audits.every((event) => event.text === native.items[0].text),
      "policy audit lost full delivery/replay",
    );
    const settledAlive = await collect();
    assert.equal(settledAlive, 0, "early replay retains item arrays after start acknowledgement");
    races.push({ status, deliveries: deliveries.length, pendingAlive, settledAlive });
  }

  references = [];
  deliveries = [];
  audits = [];
  pendingStart = undefined;
  const reconciling = seat.send("idle reconciliation fixture");
  await wait(() => pendingStart !== undefined);
  idleTurn = turn("idle-before-reply");
  send("turn/started", { threadId, turn: { id: idleTurn.id } });
  send("thread/status/changed", { threadId, status: { type: "idle" } });
  await wait(() => deliveries.length === 1);
  assert.equal(deliveries[0].text, idleTurn.items[0].text);
  pendingStart.socket.send(JSON.stringify({ id: pendingStart.id, result: { turn: { id: idleTurn.id } } }));
  await reconciling;
  const reconciledAlive = await collect();
  assert.equal(reconciledAlive, 0, "reconciled completion retains items after dispatch settles");

  references = [];
  deliveries = [];
  audits = [];
  pendingStart = undefined;
  const rejected = seat.send("rejected dispatch fixture").then(
    () => false,
    () => true,
  );
  await wait(() => pendingStart !== undefined);
  send("turn/completed", { threadId, turn: turn("rejected-reply") });
  await wait(() => deliveries.length === 1);
  pendingStart.socket.send(
    JSON.stringify({ id: pendingStart.id, error: { code: -32600, message: "fixture refusal" } }),
  );
  assert.equal(await rejected, true);
  const rejectedAlive = await collect();
  assert.equal(rejectedAlive, 0, "failed dispatch retains its full completion payload");
  console.log(
    JSON.stringify({
      ordinaryAlive,
      races,
      reconciledAlive,
      rejectedAlive,
      startRequests: methods.filter((method) => method === "turn/start").length,
    }),
  );
} finally {
  await seat?.close();
  peer?.terminate();
  await new Promise((resolve) => server.close(resolve));
}
