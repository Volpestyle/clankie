// Disposable report service for the manual real-Codex restart proof. All native
// process/listener/session checks are production code, with no observation seams.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createStubCaptain } from "../../src/captain/port.ts";
import { ConversationStore } from "../../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../../src/captain/inbound-seat-receipts.ts";
import { createHerdrCoreSeats } from "../../src/captain/herdr-core-seats.ts";
import {
  createHerdrCoreRunner,
  desktopCodexViews,
  liveDesktopTerminal,
} from "../../src/captain/herdr-core-runner.ts";
import { createCodexSeatAdapter } from "../../src/captain/codex-seat-adapter.ts";
import { localCodexServer } from "../../src/captain/codex-app-server.ts";
import { LocalCodexSeats } from "../../src/local-codex-seats.ts";
import { desktopCodexAdmission } from "../../src/desktop-codex-admission.ts";
import { localFleetAdmissionProof } from "../../src/local-fleet-proof.ts";
import { LocalFleetLink } from "../../src/local-fleet-link.ts";
import { registerSeatRoutes } from "../../src/app/seat-routes.ts";
import type { ClankieAppDependencies } from "../../src/app/types.ts";

const [root, helper] = process.argv.slice(2);
if (!root || !helper || resolve(homedir()) !== resolve(root) || process.env.NODE_ENV !== "test")
  throw new Error("Native report service requires scratch HOME and NODE_ENV=test");
const binding = { runtime: "external" as const, session: "herdr-core", socketPath: join(root, "core.sock") };
const seats = createHerdrCoreSeats({ socketPath: binding.socketPath });
const runner = createHerdrCoreRunner({
  seats,
  seatDirectory: join(root, "seats"),
  launchDirectory: join(root, "launches"),
});
let admitted = true;
let requests = 0;
const registry = new LocalCodexSeats(
  () => undefined,
  undefined,
  undefined,
  () => binding,
  desktopCodexAdmission(runner, () => binding),
);
const local = new LocalFleetLink({
  directory: join(root, "state", "links"),
  binding: async () => undefined,
  coreSocket: () => binding.socketPath,
  prove: localFleetAdmissionProof({
    processHelper: helper,
    binding: async () => undefined,
    coreBinding: async () => binding,
    coreTerminal: (_binding, address) => liveDesktopTerminal(seats, address),
    herdrBinary: "herdr",
    privateSeat: (...args) => registry.allowsAdmission(args[0], args[1], args[2], undefined, args[3]),
  }),
});
const conversations = new ConversationStore(join(root, "conversations"), async () => {});
const receipts = new InboundSeatReceipts(join(root, "inbound.json"), conversations);
const nativeBinding = "a".repeat(64);
const app = new Hono();
registerSeatRoutes({
  app,
  authenticateLane: async () => ({ denial: new Response(null, { status: 403 }) }),
  dependencies: {
    localFleet: local,
    captain: createStubCaptain({
      fleetSeatMessageBinding: async () => nativeBinding,
      fleetSeatMessageStatus: async (pane, id) => receipts.status(pane, nativeBinding, id),
      receiveFleetSeatMessage: async (pane, text, delivery) => receipts.accept(pane, delivery!, text, text),
    }),
  } as ClankieAppDependencies,
});
// No connected accounts in the proof; native bridge catalog discovery is off.
app.post("/v1/fleet/mcp", async (context) => {
  const request = await context.req.json();
  context.header("mcp-session-id", "offline-proof");
  if (request.id === undefined) return context.body(null, 202);
  return context.json({
    jsonrpc: "2.0",
    id: request.id,
    result:
      request.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "offline", version: "1" },
          }
        : {
            tools: [],
            _meta: { clankie: { tools: "off", peerMessages: "off", runtimeRevision: String(process.pid) } },
          },
  });
});
const server = serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: local.fetch((request) => {
    requests++;
    return admitted
      ? app.fetch(request)
      : Response.json({ error: "local_process_membership_required" }, { status: 403 });
  }),
});
await new Promise<void>((done) => (server.listening ? done() : server.once("listening", done)));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No native report listener");
await mkdir(join(root, "state", "links"), { recursive: true });
await writeFile(
  join(root, "state", "links", "proof.json"),
  JSON.stringify({
    schemaVersion: 2,
    authentication: "local-process",
    fleet: "herdr-core",
    socket: binding.socketPath,
    url: `http://127.0.0.1:${address.port}`,
  }),
);
process.send?.({ ready: true, port: address.port });
process.on("message", async (raw) => {
  const request = raw as { id: number; action: string };
  try {
    let result: unknown;
    if (request.action === "hire") {
      const terminal = await runner.createTab({
        cwd: root,
        harness: "codex",
        label: "Disposable restart proof",
      });
      const paneId = `herdr-core/${terminal}`;
      let serverPid: number | undefined;
      const adapter = createCodexSeatAdapter({
        desktop: desktopCodexViews(runner),
        trackerOverrides: async () => [],
        localProcess: (pid, pane) => {
          serverPid = pid;
          return registry.register(pid, pane);
        },
        server: (input) => localCodexServer({ ...input, socketRoot: root, inheritEnvironment: false }),
      });
      const launch = await adapter.start(
        {
          harness: "codex",
          cwd: root,
          brief: "",
          env: {
            PATH: process.env.PATH!,
            HOME: root,
            CODEX_HOME: join(root, "codex"),
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_STATE_HOME: join(root, "xdg-state"),
            XDG_DATA_HOME: join(root, "data"),
            XDG_CACHE_HOME: join(root, "cache"),
            XDG_RUNTIME_DIR: join(root, "runtime"),
            CLANKIE_STATE: join(root, "state"),
            HERDR_PANE_ID: paneId,
            HERDR_SOCKET_PATH: binding.socketPath,
          },
        },
        {
          paneId,
          name: "native-restart-proof",
          run: async () => {
            throw new Error("No terminal typing");
          },
          start: async (kind, args) =>
            runner.startAgent({ name: "native-restart-proof", kind, paneId: terminal, args }),
        },
      );
      if (launch.outcome !== "started") throw new Error(JSON.stringify(launch));
      const view = (await runner.paneProcesses!(terminal))[0]!;
      result = { serverPid, paneId, threadId: launch.control.ref.sessionId, view };
    } else if (request.action === "refuse") {
      admitted = false;
      result = { admitted };
    } else if (request.action === "reports")
      result = { requests, reports: conversations.inboundReports("global-default", { includeRead: true }) };
    else throw new Error("Unknown proof action");
    process.send?.({ id: request.id, result });
  } catch (error) {
    process.send?.({ id: request.id, error: String(error) });
  }
});
