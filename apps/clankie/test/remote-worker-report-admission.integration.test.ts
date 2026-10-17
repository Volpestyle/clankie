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

// VUH-2208: a PC Codex worker's message_clankie failed with binding_unavailable
// when the Windows pane proof for its binding lookup missed the relay deadline.
// The real worker bridge talks to the real service routes over HTTP; only the
// relay's proof is replaced, failing with the relay's own timeout error.
it.each([
  { phase: "binding lookup", failedProof: 1 },
  { phase: "report POST admission", failedProof: 2 },
])(
  "delivers one remote worker report after $phase times out",
  async ({ failedProof }) => {
    const root = await mkdtemp(join(tmpdir(), "clankie-remote-report-admission-"));
    const conversations = new ConversationStore(join(root, "conversations"), async () => {});
    const receiver = new InboundSeatReceipts(join(root, "inbound.json"), conversations);
    const pane = "w15:p7";
    const binding = "c".repeat(64);
    let proofs = 0;
    let accepted = 0;
    const service = await createClankieApp({
      captain: createStubCaptain({
        fleetSeatMessageBinding: async (paneId) => (paneId === `pc/${pane}` ? binding : undefined),
        receiveFleetSeatMessage: async (paneId, text, delivery) => {
          accepted += 1;
          return receiver.accept(paneId, delivery!, text, text);
        },
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
            proofs += 1;
            if (proofs === failedProof) {
              throw new RemoteObservationError("remote_observation_timeout");
            }
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
    const server = serve({ fetch: fleetLinkFetch(service.app.fetch), hostname: "127.0.0.1", port: 0 });
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

    const report = decodeMcpResult(
      await call("tools/call", { name: "message_clankie", arguments: { text: "Final report from the PC" } }),
    ) as { received: boolean; deliveryStage: string; deliveryId: string };
    expect(report).toMatchObject({ received: true, deliveryStage: "stored" });
    // Only pre-forward admission is retried, so neither timeout duplicates delivery.
    expect(proofs).toBe(3);
    expect(accepted).toBe(1);
    expect(conversations.inboundAcceptance(report.deliveryId)?.text).toBe("Final report from the PC");
  },
  30_000,
);
