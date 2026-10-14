import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import type { FleetSeatMessageReceipt } from "@clankie/protocol";
import { decodeMcpResult } from "@clankie/protocol/mcp-result";
import { afterEach, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { fleetLinkFetch } from "../src/fleet-link.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// VUH-2244: a worker report whose route outlived the service's admission
// deadline was sealed not_sent only after the bridge's own POST had timed out,
// so the worker held an uncertain claim it could never retry. The real worker
// bridge talks to the real seat routes over HTTP; only the route's work stalls.
it("answers a stalled worker report not_sent by its deadline, fences the late original and stores a resend", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-report-deadline-"));
  const conversations = new ConversationStore(join(root, "conversations"), async () => {});
  const receiver = new InboundSeatReceipts(join(root, "inbound.json"), conversations, {
    deadlineMs: 1_000,
  });
  const pane = "w15:p7";
  const binding = "c".repeat(64);
  let release!: () => void;
  const stall = new Promise<void>((resolve) => (release = resolve));
  let lateAccept!: (receipt: FleetSeatMessageReceipt) => void;
  const late = new Promise<FleetSeatMessageReceipt>((resolve) => (lateAccept = resolve));
  let stalled = false;
  const service = await createClankieApp({
    captain: createStubCaptain({
      fleetSeatMessageBinding: async (paneId) => (paneId === `pc/${pane}` ? binding : undefined),
      receiveFleetSeatMessage: async (paneId, text, delivery, request) =>
        receiver.trackAttempt(
          paneId,
          delivery!,
          text,
          async () => {
            if (stalled) return receiver.accept(paneId, delivery!, text, text);
            // The first route outlives the admission deadline, like three remote censuses.
            stalled = true;
            await stall;
            const accepted = receiver.accept(paneId, delivery!, text, text);
            lateAccept(accepted);
            return accepted;
          },
          request,
        ),
      fleetSeatMessageStatus: async (paneId, id) => receiver.status(paneId, binding, id),
      reconcileFleetSeatMessage: async (paneId, delivery, fingerprint) =>
        receiver.lookup(paneId, delivery, fingerprint),
    }),
    fleetLinks: {
      authenticate: () => undefined,
      identity: () => ({
        fleet: "pc",
        pane,
        current: () => true,
        validate: async () => true,
        projectProof: async () => ({
          fleet: "pc",
          pane,
          nativeOccupantId: "native-claude-session",
          binding: { socketPath: "native-fixture" },
          shell: { pid: 1, startTime: "native-fixture" },
          processes: [{ pid: 2, startTime: "native-fixture" }],
        }),
      }),
    },
  });
  const server = serve({ fetch: fleetLinkFetch(service.app.fetch), hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  cleanup.push(async () => {
    release();
    service.close();
    await conversations.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing service address");

  const socket = join(root, "herdr.sock");
  await mkdir(join(root, ".clankie", "links"), { recursive: true });
  await writeFile(
    join(root, ".clankie", "links", "pc.json"),
    JSON.stringify({
      schemaVersion: 2,
      authentication: "local-process",
      fleet: "pc",
      socket,
      url: `http://127.0.0.1:${String(address.port)}`,
    }),
  );
  const bridge = pathToFileURL(
    join(import.meta.dirname, "../../../integrations/claude-plugin/worker/bin/seat-channel.mjs"),
  );
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runSeatChannel} from ${JSON.stringify(bridge.href)};runSeatChannel({paneId:${JSON.stringify(pane)},parentArgv:"claude"});`,
    ],
    { env: { PATH: process.env.PATH, HOME: root, HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: pane } },
  );
  cleanup.push(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await exited;
  });
  const replies = new Map<number, { result?: unknown; error?: unknown }>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += String(chunk);
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.id !== undefined) replies.set(message.id, message);
    }
  });
  let id = 0;
  const call = async (method: string, params: unknown) => {
    const current = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
    await expect.poll(() => replies.has(current), { timeout: 15_000 }).toBe(true);
    const response = replies.get(current)!;
    expect(response.error).toBeUndefined();
    return response.result;
  };
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "1" },
  });
  const report = async () =>
    decodeMcpResult(
      await call("tools/call", { name: "message_clankie", arguments: { text: "Final report" } }),
    ) as { received: boolean; deliveryStage: string; deliveryId: string; definitive?: string };

  // Still stalled: the bridge hears a definite refusal well inside its 30s budget.
  const started = Date.now();
  const refused = await report();
  expect(refused).toMatchObject({ received: false, deliveryStage: "unavailable", definitive: "not_sent" });
  expect(Date.now() - started).toBeLessThan(10_000);

  // The late original reaches acceptance only after its sealed refusal; it never lands.
  release();
  expect(await late).toMatchObject({ received: false, definitive: "not_sent" });
  expect(conversations.inboundAcceptance(refused.deliveryId)).toBeUndefined();

  // The bridge released its claim, so the same report is safe to send again.
  const resent = await report();
  expect(resent).toMatchObject({ received: true, deliveryStage: "stored" });
  expect(resent.deliveryId).not.toBe(refused.deliveryId);
  expect(conversations.inboundAcceptance(resent.deliveryId)?.text).toBe("Final report");
}, 30_000);
