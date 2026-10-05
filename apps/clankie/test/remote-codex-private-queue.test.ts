import { readFileSync } from "node:fs";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createRemoteCodexControlObserver } from "../src/remote-project-proof.ts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import { parseHerdrAgentResult, type HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { remoteCodexControl, remoteCodexQueue } from "../src/captain/remote-codex-app-server.ts";

const fleet = { id: "pc", session: "default", ssh: { host: "pc", shell: "powershell" as const } };
const raw = readFileSync(new URL("./fixtures/windows-codex-private-control.json", import.meta.url), "utf8");
const pane = "w8:pB";
const qualified = `${fleet.id}/${pane}`;
const sessionId = "01a10928-d878-7db2-82d0-643dce239a3f";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it("refuses queue when a proven private steer becomes idle and its native proof disappears", async () => {
  // The real Windows producer golden proves the initial custom-home backend.
  // A local native-protocol server substitutes only its WebSocket transport.
  let available = true;
  const observe = createRemoteCodexControlObserver({
    fleet: async (id) => (id === fleet.id ? fleet : undefined),
    shell: () => async () => {
      if (!available) throw new Error("Current Windows process facts unavailable");
      return raw;
    },
  });
  const initial = await observe(fleet.id, pane, sessionId);
  expect(initial).toBeDefined();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Test socket unavailable");
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const requests: string[] = [];
  let clientPort: number | undefined;
  server.on("connection", (socket, request) => {
    clientPort = request.socket.remotePort;
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as { id?: number; method: string };
      requests.push(request.method);
      if (request.method === "initialized") return;
      if (request.method === "thread/read") {
        // The private turn settled after proof and read-only connection setup.
        // The next proof fails; it cannot identify any account-default home.
        available = false;
        socket.send(
          JSON.stringify({ id: request.id, result: { thread: { id: sessionId, status: { type: "idle" } } } }),
        );
      } else socket.send(JSON.stringify({ id: request.id, result: {} }));
    });
  });
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}`);
    await once(socket, "open");
    if (clientPort === undefined) throw new Error("Test TCP client unavailable");
    return {
      socket,
      connection: { clientPort, serverPort: address.port },
      alive: () => socket.readyState === WebSocket.OPEN,
      close: () => socket.terminate(),
    };
  };
  let cliCalls = 0;
  const shell = async () => {
    cliCalls++;
    throw new Error("Account-default CLI queue must not be reached");
  };
  const herdr = async () => "";
  const queue = remoteCodexQueue(fleet, shell, (target) =>
    remoteCodexControl(fleet, shell, herdr, target, { observe, connect, mode: "queue" }),
  );
  const snapshots = JSON.parse(raw) as { first: { agent: unknown } };
  const agent = parseHerdrAgentResult(JSON.stringify({ result: { agent: snapshots.first.agent } }));
  const delivery = createFleetSeatControl(
    { resolveTerminal: async () => ({ ...agent, paneId: qualified }) } as unknown as HerdrWatchRunner,
    new Map(),
    undefined,
    async (_fleet, thread, text, guard, target) => queue(thread, text, guard, target),
    (_fleet, target) => remoteCodexControl(fleet, shell, herdr, target, { observe, connect }),
  );
  expect(
    await delivery.deliverToSeat(qualified, "Deliver once to the original private thread"),
  ).toMatchObject({
    outcome: "undelivered",
    deliveryStage: "unavailable",
  });
  expect(requests).toEqual(["initialize", "initialized", "thread/read"]);
  expect(cliCalls).toBe(0);
});

it.each(["missing control", "unavailable proof"])(
  "refuses %s for a targeted Windows queue before account CLI discovery",
  async (kind) => {
    let cliCalls = 0;
    const shell = async () => {
      cliCalls++;
      return "C:\\npm\\codex.js";
    };
    const queue = remoteCodexQueue(
      fleet,
      shell,
      kind === "missing control" ? undefined : () => async () => undefined,
    );
    expect(await queue(sessionId, "unproven queue", undefined, qualified)).toMatchObject({
      outcome: "undelivered",
      deliveryStage: "unavailable",
    });
    expect(cliCalls).toBe(0);
  },
);
