import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
// Real durable mailbox and native-control fence, with a recorded Herdr observation.
// The transport adapter projects the real mailbox ACK; no transcript is available.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claude-exact-receipt-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const mailbox = new SeatOutbox({ uncertaintyPath: join(root, "mailbox.json"), boundGraceMs: 30 });
  cleanups.push(() => mailbox.close());
  let agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "seat1",
    agent: "claude",
    status: "idle",
    title: "worker",
    session: { source: "herdr:claude", kind: "id", value: "session1" },
  };
  let sends = 0;
  const control: SeatControl = {
    ref: { harness: "claude", paneId: "w1:p1", sessionId: "session1" },
    send: async (text, options) => {
      sends++;
      const result = await mailbox.deliver({
        kind: "message",
        conversationId: "lead",
        source: "service",
        content: text,
        wantsReply: false,
        ...(options?.recipientBinding === undefined ? {} : { recipientBinding: options.recipientBinding }),
      });
      return result.outcome === "delivered"
        ? { outcome: "accepted", messageId: result.messageId!, deliveryStage: "delivered", state: "queued" }
        : result.outcome === "unconfirmed"
          ? result
          : { outcome: "released" };
    },
    status: async () => "idle",
    settled: async () => ({ type: "released", at: new Date().toISOString() }),
    interrupt: async () => false,
    close: async () => {},
  };
  const adapter: HarnessSeatAdapter = {
    harness: "claude",
    attach: async () => control,
    start: async () => ({ outcome: "started", control }),
  };
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => agent,
    transcript: async () => {
      throw new Error("Remote transcript unavailable");
    },
  };
  const create = () =>
    createFleetSeatControl(
      runner,
      new Map([["claude", adapter]]),
      undefined,
      undefined,
      undefined,
      join(root, "watches.json.delivery-receipts.json"),
      async (id) => {
        const receipt = mailbox.recoveryReceipt(id);
        return receipt
          ? { seatId: "seat1", receipt, acknowledged: mailbox.recoveryAcknowledged(id) }
          : undefined;
      },
    );
  return {
    root,
    runner,
    mailbox,
    create,
    sends: () => sends,
    replace: () => {
      agent = { ...agent, session: { source: "herdr:claude", kind: "id", value: "replacement" } };
    },
  };
}
const options = { conversationId: "lead", recipientBinding: "binding1" };
it("delivers two consecutive exact acknowledgments without waiting for a remote transcript", async () => {
  const f = fixture(),
    native = f.create();
  for (const text of ["first", "second"]) {
    const poll = f.mailbox.poll(1000, undefined, "binding1");
    const delivery = native.deliverToSeat("seat1", text, undefined, options);
    const [event] = await poll;
    expect(event?.content).toContain(text);
    expect(f.mailbox.acknowledge(event!.id, "wrong-binding")).toBe(false);
    expect(f.mailbox.acknowledge("seat-invented", "binding1")).toBe(false);
    expect(f.mailbox.acknowledge(event!.id, "binding1")).toBe(true);
    expect(await delivery).toMatchObject({
      outcome: "delivered",
      deliveryStage: "delivered",
      messageId: event!.id,
    });
  }
  expect(f.sends()).toBe(2);
  expect(native.unresolvedDeliveries()).toEqual([]);
});
it("retains the exact blocking event across restart and reconciles a late acknowledgment without replay", async () => {
  const f = fixture();
  const poll = f.mailbox.poll(1000, undefined, "binding1");
  const delivery = f.create().deliverToSeat("seat1", "original", undefined, options);
  const [event] = await poll;
  expect(await delivery).toMatchObject({ outcome: "unconfirmed", messageId: event!.id });
  const restarted = f.create();
  expect(restarted.unresolvedDeliveries()).toMatchObject([
    { receiptId: event!.id, seatId: "seat1", conversationId: "lead" },
  ]);
  expect(await restarted.deliverToSeat("seat1", "followup", undefined, options)).toMatchObject({
    outcome: "undelivered",
  });
  await f.mailbox.poll(0, undefined, "binding1");
  expect(f.mailbox.recoveryAcknowledged(event!.id)).toBe(false);
  expect(await restarted.reconcileDelivery("seat-invented")).toBeUndefined();
  expect(await restarted.reconcileDelivery(event!.id)).toMatchObject({ outcome: "unconfirmed" });
  expect(f.mailbox.acknowledge(event!.id, "binding1")).toBe(true);
  expect(await restarted.reconcileDelivery(event!.id)).toMatchObject({
    outcome: "delivered",
    deliveryStage: "delivered",
    messageId: event!.id,
  });
  expect(f.sends()).toBe(1);
  expect(f.create().unresolvedDeliveries()).toEqual([]);
});
it("sends a different message once the receiver's late acknowledgment settles the original (VUH-2034)", async () => {
  const f = fixture(),
    native = f.create();
  const poll = f.mailbox.poll(1000, undefined, "binding1");
  const delivery = native.deliverToSeat("seat1", "original", undefined, options);
  const [event] = await poll;
  expect(await delivery).toMatchObject({ outcome: "unconfirmed", messageId: event!.id });
  // Unproven, the original still blocks a different message, and names itself.
  const refused = await native.deliverToSeat("seat1", "next", undefined, options);
  expect(refused).toMatchObject({ outcome: "undelivered" });
  expect(refused.outcome === "undelivered" && refused.detail).toContain(event!.id);
  expect(f.mailbox.acknowledge(event!.id, "binding1")).toBe(true);
  const nextPoll = f.mailbox.poll(1000, undefined, "binding1");
  const next = native.deliverToSeat("seat1", "next", undefined, options);
  const [nextEvent] = await nextPoll;
  expect(nextEvent!.content).toContain("next");
  f.mailbox.acknowledge(nextEvent!.id, "binding1");
  expect(await next).toMatchObject({ outcome: "delivered", messageId: nextEvent!.id });
  expect(f.sends()).toBe(2);
  expect(native.unresolvedDeliveries()).toEqual([]);
});
it("sends a different message once the original appears in the receiver's own transcript (VUH-2034)", async () => {
  const f = fixture(),
    native = f.create();
  let entries: { id: string; type: "message"; role: "operator"; text: string }[] = [];
  f.runner.transcript = async () => ({ entries }) as never;
  const poll = f.mailbox.poll(1000, undefined, "binding1");
  const delivery = native.deliverToSeat("seat1", "original", undefined, options);
  const [event] = await poll;
  expect(await delivery).toMatchObject({ outcome: "unconfirmed", messageId: event!.id });
  // The bridge wrote the event but its ack never landed; the session shows it.
  entries = [{ id: "entry-1", type: "message", role: "operator", text: "original" }];
  const nextPoll = f.mailbox.poll(1000, undefined, "binding1");
  const next = native.deliverToSeat("seat1", "next", undefined, options);
  const [nextEvent] = await nextPoll;
  expect(nextEvent!.id).not.toBe(event!.id);
  expect(nextEvent!.content).toContain("next");
  f.mailbox.acknowledge(nextEvent!.id, "binding1");
  expect(await next).toMatchObject({ outcome: "delivered" });
  expect(f.sends()).toBe(2);
  expect(native.unresolvedDeliveries()).toEqual([]);
});
it("does not accept a late acknowledgment from a replaced native occupant", async () => {
  const f = fixture(),
    native = f.create();
  const poll = f.mailbox.poll(1000, undefined, "binding1");
  const delivery = native.deliverToSeat("seat1", "original", undefined, options);
  const [event] = await poll;
  await delivery;
  f.mailbox.acknowledge(event!.id, "binding1");
  f.replace();
  expect(await native.reconcileDelivery(event!.id)).toMatchObject({ outcome: "unconfirmed" });
  expect(native.unresolvedDeliveries()).toHaveLength(1);
  expect(f.sends()).toBe(1);
});
it("owner abandonment frees the recipient while retaining unknown evidence and never replaying", async () => {
  const f = fixture(),
    native = f.create();
  const poll = f.mailbox.poll(1000, undefined, "binding1");
  const delivery = native.deliverToSeat("seat1", "original", undefined, options);
  const [event] = await poll;
  await delivery;
  await expect(
    native.abandonDelivery(event!.id, async () => {
      throw new Error("owner authority revoked");
    }),
  ).rejects.toThrow("revoked");
  expect(native.unresolvedDeliveries()).toHaveLength(1);
  expect(await native.abandonDelivery(event!.id)).toMatchObject({ disposition: "abandoned-unknown" });
  f.mailbox.abandonUnknown(event!.id);
  expect(f.create().unresolvedDeliveries()).toEqual([]);
  const nextPoll = f.mailbox.poll(1000, undefined, "binding1");
  const next = f.create().deliverToSeat("seat1", "new intent", undefined, options);
  const [nextEvent] = await nextPoll;
  expect(nextEvent!.id).not.toBe(event!.id);
  expect(nextEvent!.content).toContain("new intent");
  f.mailbox.acknowledge(nextEvent!.id, "binding1");
  expect(await next).toMatchObject({ outcome: "delivered" });
  expect(f.sends()).toBe(2);
});
it("lists the native fence after its mailbox ACK and permits only an authenticated owner to abandon it", async () => {
  const f = fixture();
  const poll = f.mailbox.poll(1000, undefined, "binding1");
  const delivery = f.create().deliverToSeat("seat1", "original", undefined, options);
  const [event] = await poll;
  await delivery;
  f.mailbox.acknowledge(event!.id, "binding1");
  const watches = new HerdrWatchStore(join(f.root, "watches.json"), { runner: f.runner });
  const serve = createOperatorService({
    personas: { ready: async () => {} },
    settingsStore: {},
    deps: {},
    shutdown: new AbortController(),
    herdrWatches: watches,
    headSeatConversations: () => [],
    fleetSeatOutboxes: () => [["seat1", f.mailbox]],
    conversations: { conversationIdForSeat: () => "lead" },
    seatOutbox: () => f.mailbox,
  } as unknown as CreateOperatorServiceContext);
  expect(await serve({ op: "seat_deliveries", schemaVersion: 1 })).toMatchObject({
    unresolved: [{ conversationId: "lead", seatId: "seat1", receiptId: event!.id }],
  });
  await expect(watches.reconcileSeatDelivery(event!.id, "another-lead")).rejects.toThrow(
    "another conversation",
  );
  const request = {
    op: "settle_seat_delivery" as const,
    schemaVersion: 1 as const,
    conversationId: "lead",
    receiptId: event!.id,
    disposition: "abandoned-unknown" as const,
  };
  await expect(serve(request)).rejects.toThrow("authority is required");
  const authority = {
    principal: { kind: "operator" as const, id: "owner" },
    current: () => true,
    authorize: async () => true,
  };
  expect(await serve({ ...request, conversationId: "another-lead" }, authority)).toMatchObject({
    result: { state: "refused" },
  });
  expect(await serve(request, authority)).toMatchObject({ result: { state: "abandoned-unknown" } });
  expect(await serve({ op: "seat_deliveries", schemaVersion: 1 })).toMatchObject({ unresolved: [] });
  expect(f.sends()).toBe(1);
});
it("reconciles both native and MCP dispatch IDs through the operator HTTP route without redispatch", async () => {
  const { createClankieApp } = await import("../src/app.ts");
  const { createStubCaptain } = await import("../src/captain/port.ts");
  const f = fixture(),
    native = f.create();
  const watches = () =>
    new HerdrWatchStore(join(f.root, "watches.json"), {
      runner: f.runner,
      channelReceipt: async (id) => {
        const receipt = f.mailbox.recoveryReceipt(id);
        return receipt
          ? { seatId: "seat1", receipt, acknowledged: f.mailbox.recoveryAcknowledged(id), settle: () => {} }
          : undefined;
      },
    });
  const app = await createClankieApp({
    seatCallReceiptPath: join(f.root, "mcp-receipts.json"),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer proof-owner" ? { operatorId: "owner" } : undefined,
    captain: createStubCaptain({
      laneToolBank: async (lane) => ({
        lane,
        tools: [
          {
            name: "message_seat",
            description: "Deliver to the recorded native seat",
            inputSchema: { type: "object", properties: {} },
            call: async () => ({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    await native.deliverToSeat("seat1", "original", undefined, {
                      ...options,
                      conversationId: "global-default",
                    }),
                  ),
                },
              ],
            }),
          },
        ],
      }),
      reconcileSeatDelivery: (id, conversationId) =>
        watches().reconcileSeatDelivery(id, conversationId ?? "global-default"),
    }),
  });
  let session: string | undefined;
  const rpc = async (body: unknown) =>
    app.app.request("/v1/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer proof-owner",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const opened = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "proof", version: "1" },
      },
    });
    session = opened.headers.get("mcp-session-id")!;
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    const poll = f.mailbox.poll(1000, undefined, "binding1");
    const response = rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "message_seat", arguments: {} },
    });
    const [event] = await poll;
    const body = await (await response).json();
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      outcome: "unconfirmed",
      messageId: event!.id,
    });
    const callId = body.result._meta["clankie/seat-call"].id;
    f.mailbox.acknowledge(event!.id, "binding1");
    const reconciled = await (
      await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "reconcile_seat_call", arguments: { deliveryId: callId } },
      })
    ).json();
    expect(JSON.parse(reconciled.result.content[0].text)).toMatchObject({
      outcome: "delivered",
      deliveryStage: "delivered",
      messageId: event!.id,
    });
    expect(f.sends()).toBe(1);
    expect(native.unresolvedDeliveries()).toHaveLength(1); // A separate process reloads its durable fence.
    expect(f.create().unresolvedDeliveries()).toEqual([]);
  } finally {
    app.close();
  }
});

it("keeps legacy fences visible and settleable without guessing an ACK from matching content", async () => {
  const f = fixture();
  const poll = f.mailbox.poll(1000, undefined, "binding1");
  const delivery = f.create().deliverToSeat("seat1", "original", undefined, options);
  const [event] = await poll;
  await delivery;
  const path = join(f.root, "watches.json.delivery-receipts.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  delete saved.seat1.nativeDeliveryId;
  writeFileSync(path, JSON.stringify(saved));
  f.mailbox.acknowledge(event!.id, "binding1");
  expect(await f.create().reconcileDelivery("seat-invented")).toBeUndefined();
  expect(await f.create().reconcileDelivery(event!.id)).toBeUndefined();
  const originalId = saved.seat1.messageId;
  expect(f.create().unresolvedDeliveries()).toMatchObject([{ receiptId: originalId, seatId: "seat1" }]);
  expect(await f.create().abandonDelivery(originalId)).toMatchObject({ disposition: "abandoned-unknown" });
  expect(f.create().unresolvedDeliveries()).toEqual([]);
  expect(f.sends()).toBe(1);
});
