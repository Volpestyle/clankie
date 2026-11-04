import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { decodeMcpResult } from "@clankie/protocol/mcp-result";
import { afterEach, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { fleetLinkFetch } from "../src/fleet-link.ts";
import { RemoteObservationError } from "../src/remote-fleet-relay.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// #845: the real native bridge, HTTP admission routes and durable lead inbox.
// Only admission availability and lost HTTP replies are controlled.
it("recovers report admission and lost receipts across bridge and receiver restarts (#845)", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-report-recovery-"));
    const conversations = new ConversationStore(join(root, "conversations"), async () => {});
    let receiver = new InboundSeatReceipts(join(root, "inbound.json"), conversations);
    const pane = "w15:p7";
    const binding = "c".repeat(64);
    let unavailable = true;
    let loseReply: "binding" | "post" | undefined;
    let accepted = 0;
    const service = await createClankieApp({
      captain: createStubCaptain({
        fleetSeatMessageBinding: async (paneId) => (paneId === `pc/${pane}` ? binding : undefined),
        receiveFleetSeatMessage: async (paneId, text, delivery, _request, options) => {
          accepted += 1;
          return receiver.accept(
            paneId,
            delivery!,
            text,
            text,
            undefined,
            undefined,
            undefined,
            undefined,
            options?.urgent === true || options?.kind === "blocked",
            undefined,
            undefined,
            options?.kind,
          );
        },
        reconcileFleetSeatMessage: async (paneId, delivery, fingerprint) => receiver.lookup(paneId, delivery, fingerprint),
        fleetSeatMessageStatus: async (paneId, id) => receiver.status(paneId, binding, id),
      }),
      fleetLinks: {
        authenticate: () => undefined,
        identity: () => ({
          fleet: "pc",
          pane,
          current: () => true,
          validate: async () => true,
          projectProof: async () => {
            if (unavailable) throw new RemoteObservationError("remote_observation_timeout");
            return {
              fleet: "pc",
              pane,
              nativeOccupantId: "native-codex-thread",
              binding: { socketPath: "native-fixture" },
              shell: { pid: 1, startTime: "native-fixture" },
              processes: [{ pid: 2, startTime: "native-fixture" }],
            };
          },
        }),
      },
    });
    const route = fleetLinkFetch(service.app.fetch);
    const server = serve({
      fetch: async (request, env) => {
        const response = await route(request, env);
        if (loseReply === "binding" && request.method === "GET" && new URL(request.url).pathname.endsWith("/messages") || loseReply === "post" && request.method === "POST" && new URL(request.url).pathname.endsWith("/messages")) {
          loseReply = undefined;
          env.incoming.socket.destroy();
        }
        return response;
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
    cleanup.push(async () => {
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

    // The Windows relay publishes a process-authenticated link, not a bearer.
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
    const startBridge = async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {runSeatChannel} from ${JSON.stringify(bridge.href)};runSeatChannel({paneId:${JSON.stringify(pane)},parentArgv:"codex"});`,
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
      clientInfo: { name: "codex", version: "1" },
    });

    return { call, stop: async () => { const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill(); await exited; } };
    };
    let client = await startBridge();
    const report = async (text = "Final report from the PC") => decodeMcpResult(
      await client.call("tools/call", {
        name: "message_clankie",
        arguments: { text, kind: "blocked" },
      }),
    ) as { received: boolean; deliveryStage: string; deliveryId: string };
    // Explicit admission failure is undispatched, with no phantom pending original.
    expect(await report()).toMatchObject({ received: false, deliveryStage: "unavailable", retryable: true });
    expect(accepted).toBe(0);
    // A failed binding read is also certainly before dispatch, even with no HTTP answer.
    unavailable = false;
    loseReply = "binding";
    expect(await report()).toMatchObject({ received: false, deliveryStage: "unavailable", retryable: true });
    expect(accepted).toBe(0);
    // The next fresh call reaches the lead; lose its positive reply to create real uncertainty.
    loseReply = "post";
    const original = await report();
    expect(original).toMatchObject({ received: false, deliveryStage: "uncertain", deliveryId: expect.any(String) });
    expect(accepted).toBe(1);
    expect(conversations.inboundAcceptance(original.deliveryId)?.text).toBe("Final report from the PC");
    // Reload both journals as a service/bridge restart would, without sending the original again.
    await client.stop();
    receiver = new InboundSeatReceipts(join(root, "inbound.json"), conversations);
    client = await startBridge();
    unavailable = true;
    expect(await report("Different follow-up")).toMatchObject({ deliveryStage: "uncertain", deliveryId: original.deliveryId });
    expect(accepted).toBe(1);
    unavailable = false;
    const settled = await report("Different follow-up");
    expect(settled).toMatchObject({ received: false, deliveryStage: "unavailable", deliveryId: original.deliveryId });
    expect(accepted).toBe(1);
    expect(decodeMcpResult(await client.call("tools/call", { name: "message_clankie_status", arguments: { deliveryId: original.deliveryId } }))).toMatchObject({ deliveryId: original.deliveryId, deliveryStage: "stored" });
    const followUp = await report("Different follow-up");
    expect(followUp).toMatchObject({ received: true, deliveryStage: "stored" });
    expect(followUp.deliveryId).not.toBe(original.deliveryId);
    expect(conversations.inboundAcceptance(followUp.deliveryId)?.text).toBe("Different follow-up");
    expect(accepted).toBe(2);
}, 30_000);
