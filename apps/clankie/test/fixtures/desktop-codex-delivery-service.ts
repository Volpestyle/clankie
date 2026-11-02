// Disposable service controller for #277. The desktop core is a read-only
// terminal snapshot; native worker process, Unix server and delivery are real.
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { registerSeatRoutes } from "../../src/app/seat-routes.ts";
import type { ClankieAppDependencies } from "../../src/app/types.ts";
import { createStubCaptain } from "../../src/captain/port.ts";
import { ConversationStore } from "../../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../../src/captain/inbound-seat-receipts.ts";
import { LocalFleetLink } from "../../src/local-fleet-link.ts";
import { localFleetAdmissionProof } from "../../src/local-fleet-proof.ts";
import { LocalCodexSeats } from "../../src/local-codex-seats.ts";
import { desktopCodexAdmission } from "../../src/desktop-codex-admission.ts";
import { observeNativeBirth, nativeProcessReceipt } from "../../src/local-fleet-process.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createHerdrCoreRunner,
  HERDR_CORE_FLEET,
  liveDesktopTerminal,
} from "../../src/captain/herdr-core-runner.ts";
import type { HerdrCoreTerminal, HerdrCoreSeats } from "../../src/captain/herdr-core-seats.ts";
import { routeHerdrFleets } from "../../src/captain/herdr-fleet-runner.ts";
import { HerdrWatchStore } from "../../src/captain/herdr-watch.ts";

const root = process.argv[2]!;
const processHelper = process.argv[3]!;
if (!root || resolve(homedir()) !== resolve(root) || process.env.NODE_ENV !== "test")
  throw new Error("Desktop delivery fixture requires its scratch HOME and NODE_ENV=test");
const terminals = async (): Promise<HerdrCoreTerminal[]> =>
  JSON.parse(await readFile(join(root, "terminals.json"), "utf8"));
const forbidden = async (): Promise<never> => {
  throw new Error("No terminal mutation in delivery fixture");
};
const seats: HerdrCoreSeats = {
  available: async () => true,
  list: terminals,
  get: async (address) => (await terminals()).find((terminal) => terminal.address === address),
  start: forbidden,
  kill: forbidden,
  read: forbidden,
  label: forbidden,
  keys: forbidden,
};
const desktop = createHerdrCoreRunner({ seats, seatDirectory: join(root, "seats") });
const runner = routeHerdrFleets(
  { get: forbidden, resolveTerminal: async () => undefined, wait: forbidden },
  new Map([[HERDR_CORE_FLEET, desktop]]),
);
const watches = new HerdrWatchStore(join(root, "subprocess-watch.json"), {
  runner,
  seatAdapters: [],
  remoteSeatAdapters: () => [],
  remoteCodexQueue: forbidden,
});
const binding = {
  runtime: "external" as const,
  session: HERDR_CORE_FLEET,
  socketPath: join(root, "core.sock"),
};
const native = JSON.parse(await readFile(join(root, "native-server.json"), "utf8")) as {
  pid: number;
  endpoint: string;
  paneId: string;
  threadId: string;
};
// Only the Codex executable/listener seam is controlled: the protocol fixture
// lives in the parent test process. Socket owner, ancestry and births are native.
const recovery = desktopCodexAdmission(
  desktop,
  () => binding,
  async (pid, endpoint, _canonical, signal) =>
    pid === native.pid && endpoint === native.endpoint
      ? observeNativeBirth(pid, signal, processHelper)
      : undefined,
);
const registry = new LocalCodexSeats(
  () => undefined,
  async (pid, previous, signal) => {
    const birth = await observeNativeBirth(pid, signal, processHelper);
    return birth ? nativeProcessReceipt(birth, previous) : undefined;
  },
  undefined,
  () => binding,
  recovery,
);
// Before restart, reproduce the launch adapter's original heap registration.
// The replacement service receives no registration and must recover admission.
if (process.argv[4] === "initial")
  await registry.register(native.pid, native.paneId).bindSession?.(native.threadId, native.endpoint);
const local = new LocalFleetLink({
  directory: join(root, "links"),
  binding: async () => undefined,
  coreSocket: () => binding.socketPath,
  prove: localFleetAdmissionProof({
    processHelper,
    binding: async () => undefined,
    coreBinding: async () => binding,
    coreTerminal: (_binding, address) => liveDesktopTerminal(seats, address),
    herdrBinary: "herdr",
    privateSeat: (...args) => registry.allowsAdmission(args[0], args[1], args[2], undefined, args[3]),
  }),
});
const conversations = new ConversationStore(join(root, "conversations"), async () => {});
const receipts = new InboundSeatReceipts(join(root, "inbound.json"), conversations);
const app = new Hono();
registerSeatRoutes({
  app,
  authenticateLane: async () => ({ denial: new Response(null, { status: 403 }) }),
  dependencies: {
    localFleet: local,
    captain: createStubCaptain({
      receiveFleetSeatMessage: async (pane, text, delivery) =>
        receipts.accept(pane, delivery!, text, `Worker report: ${text}`),
    }),
  } as ClankieAppDependencies,
});
const http = serve({ hostname: "127.0.0.1", port: 0, fetch: local.fetch((request) => app.fetch(request)) });
await new Promise<void>((done) => (http.listening ? done() : http.once("listening", done)));
const listener = http.address();
if (!listener || typeof listener === "string") throw new Error("No report listener");
process.on("message", async (raw) => {
  const request = raw as { seatId: string; text: string; receipt: string };
  try {
    const result = await watches.deliverToSeat(request.seatId, request.text, undefined, {
      stableReceiptKey: request.receipt,
      delivery: "queue",
    });
    process.send?.({ result });
  } catch (error) {
    process.send?.({ error: String(error) });
  }
});
process.send?.({ ready: true, port: listener.port });
