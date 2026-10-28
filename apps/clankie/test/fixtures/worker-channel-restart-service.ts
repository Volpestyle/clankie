// Disposable HTTP runtime for VUH-2944. Only native process admission is a
// fixture; routes, mailbox fences, report storage and acknowledgments are real.
import { serve } from "@hono/node-server";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createClankieApp } from "../../src/app.ts";
import { createStubCaptain } from "../../src/captain/port.ts";
import { ConversationStore } from "../../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../../src/captain/inbound-seat-receipts.ts";
import { deliverFleetSeatMessage, fleetSeatMailbox } from "../../src/captain/fleet-seat.ts";
import type { SeatOutbox } from "../../src/captain/seat-outbox.ts";

const [root, mode] = process.argv.slice(2);
if (!root || resolve(homedir()) !== resolve(root) || process.env.NODE_ENV !== "test")
  throw new Error("Worker channel fixture requires its scratch HOME and NODE_ENV=test");
const binding = "a".repeat(64);
const mailboxes = new Map<string, SeatOutbox>();
const mailbox = (pane: string) => fleetSeatMailbox(mailboxes, pane, join(root, "mailboxes"));
const conversations = new ConversationStore(join(root, "conversations"), async () => {});
const receipts = new InboundSeatReceipts(join(root, "inbound.json"), conversations);
const acks: string[] = [];
let holdAck = mode === "hold-ack" || mode === "lost-ack";
const app = await createClankieApp({
  localFleet: {
    identity: (request) => ({
      pane: request.headers.get("x-clankie-pane") ?? "",
      validate: async () => ["sable", "kit"].includes(request.headers.get("x-clankie-pane") ?? ""),
    }),
  },
  captain: createStubCaptain({
    fleetSeatMessageBinding: async () => binding,
    receiveFleetSeatMessage: async (pane, text, delivery) => receipts.accept(pane, delivery!, text, text),
    fleetSeatMessageStatus: async (pane, id) => receipts.status(pane, binding, id),
    pollFleetSeatEvents: async (pane, waitMs, signal) => {
      const events = await mailbox(pane).poll(waitMs, signal, binding);
      return events.length ? [...events, ...conversations.senderReportEvents(pane, binding)] : [];
    },
    acknowledgeFleetSeatEvent: async (pane, id) => {
      const acknowledged = id.startsWith("report:")
        ? conversations.acknowledgeSenderReportEvent(pane, binding, id)
        : mailbox(pane).acknowledge(id, binding);
      if (acknowledged) acks.push(id);
      return acknowledged;
    },
  }),
});
const server = serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    // Interrupt a receipt after its notification was written, optionally after
    // the server committed its ACK. Killing this exact child drops the reply.
    if (holdAck && path.includes("/sable/events/report%3A") && path.endsWith("/ack")) {
      holdAck = false;
      if (mode === "lost-ack") await app.app.fetch(request);
      process.send?.({ state: "ack-held", eventId: decodeURIComponent(path.split("/").at(-2)!) });
      return new Promise<Response>(() => {});
    }
    return app.app.fetch(request);
  },
});
server.once("listening", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture HTTP address");
  process.send?.({ state: "ready", port: address.port });
});

process.on("message", async (raw) => {
  const command = raw as { id: number; action: string; pane: string; reportId?: string; text?: string };
  try {
    let result: unknown;
    if (command.action === "seed-report") {
      result = receipts.accept(
        command.pane,
        { id: command.reportId!, binding },
        "Original report",
        "Original report",
      );
      conversations.readInboundReports("global-default");
    } else if (command.action === "deliver") {
      result = await deliverFleetSeatMessage(mailboxes, command.pane, command.text!, {
        conversationId: "fixture",
        source: "captain",
        recipientBinding: binding,
      });
    } else if (command.action === "status") {
      result = {
        bound: { sable: mailbox("sable").boundTo(binding), kit: mailbox("kit").boundTo(binding) },
        acks,
        pendingReports: conversations.senderReportEvents(command.pane, binding).map((event) => event.id),
      };
    } else throw new Error(`Unknown fixture command: ${command.action}`);
    process.send?.({ state: "reply", id: command.id, result });
  } catch (error) {
    process.send?.({ state: "reply", id: command.id, error: String(error) });
  }
});

// The test owns this exact process and crashes it to exercise disk recovery.
// Its IPC pipe closing also cleans it up if the test runner disappears.
process.once("disconnect", () => process.exit(0));
