import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import { DeliveryFence, deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";

// VUH-2358: one uncertain delivery (a peer handoff whose acknowledgment never
// came) refused every later lead message to that seat, and nothing could settle
// it. The real durable mailbox, native-control fence, watch store and lane MCP
// endpoint run here; the recipient's transcript is a recorded observation that
// shows the original never arrived.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "seat-delivery-settle-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const mailbox = new SeatOutbox({ uncertaintyPath: join(root, "mailbox.json"), boundGraceMs: 30 });
  cleanups.push(() => mailbox.close());
  let status = "idle";
  let transcriptAvailable = true;
  let sessionId = "session1";
  const agent = (): HerdrAgentSnapshot => ({
    paneId: "w1:p1",
    terminalId: "seat1",
    agent: "claude",
    status,
    title: "worker",
    session: { source: "herdr:claude", kind: "id", value: sessionId },
  });
  let sends = 0;
  const control: SeatControl = {
    ref: { harness: "claude", paneId: "w1:p1", sessionId: "session1" },
    send: async (text, options) => {
      sends++;
      const result = await mailbox.deliver({
        kind: "message",
        conversationId: "global-default",
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
  // The recipient's own session: whatever arrived there, nothing else.
  let entries: {
    id: string;
    type: "message";
    role: "operator";
    text: string;
    occurredAt?: string | undefined;
  }[] = [];
  const runner: HerdrWatchRunner = {
    get: async () => agent(),
    resolveTerminal: async () => agent(),
    wait: async () => agent(),
    transcript: async () => (transcriptAvailable ? ({ entries } as never) : undefined),
  };
  let now = Date.now();
  const receiptsPath = join(root, "watches.json.delivery-receipts.json");
  const channelReceipt = async (id: string) => {
    const receipt = mailbox.recoveryReceipt(id);
    return receipt ? { seatId: "seat1", receipt, acknowledged: mailbox.recoveryAcknowledged(id) } : undefined;
  };
  const create = () =>
    createFleetSeatControl(
      runner,
      new Map([["claude", adapter]]),
      undefined,
      undefined,
      undefined,
      receiptsPath,
      channelReceipt,
      undefined,
      { unarrivedSettleMs: 60_000, now: () => now },
    );
  const watches = () =>
    new HerdrWatchStore(join(root, "watches.json"), {
      runner,
      channelReceipt: async (id) => {
        const found = await channelReceipt(id);
        return found ? { ...found, settle: () => {} } : undefined;
      },
    });
  // A lost acknowledgment: the bridge takes the event but never confirms it, and
  // the recipient's session never shows it.
  const lostOriginal = async (native: ReturnType<typeof create>) => {
    const poll = mailbox.poll(1000, undefined, "binding1");
    const pending = native.deliverToSeat("seat1", "handoff: start the release", undefined, options);
    await poll;
    const delivery = await pending;
    expect(delivery).toMatchObject({ outcome: "unconfirmed" });
    return delivery.outcome === "unconfirmed" ? delivery.messageId! : "";
  };
  // A following message the recipient takes and acknowledges.
  const deliverNext = async (native: ReturnType<typeof create>, text: string) => {
    const poll = mailbox.poll(1000, undefined, "binding1");
    const next = native.deliverToSeat("seat1", text, undefined, options);
    const [event] = await poll;
    expect(event?.content).toContain(text);
    mailbox.acknowledge(event!.id, "binding1");
    return next;
  };
  return {
    root,
    seedInterrupted: (conversationId = "visiting-conversation") => {
      const receipt = new DeliveryFence(receiptsPath).begin("seat1", {
        fingerprint: deliveryFingerprint("handoff: start the release"),
        beganAt: now,
        sessionId,
        paneId: agent().paneId,
        occupantId: occupantIdForHerdrSession(agent().session!),
        conversationId,
        recipientBinding: "binding1",
      });
      return receipt.messageId;
    },
    hire: (conversationId: string) =>
      new HireOwners(join(root, "watches.json.owners.json")).bind(
        agent().paneId,
        { conversationId },
        "seat1",
        undefined,
        occupantIdForHerdrSession(agent().session!),
      ),
    changeOccupant: () => {
      sessionId = "replacement";
    },
    hideTranscript: () => {
      transcriptAvailable = false;
    },
    setStatus: (next: string) => {
      status = next;
    },
    mailbox,
    create,
    watches,
    lostOriginal,
    deliverNext,
    sends: () => sends,
    arrive: (text: string, occurredAt?: string) => {
      entries = [
        ...entries,
        { id: `entry-${String(entries.length + 1)}`, type: "message", role: "operator", text, occurredAt },
      ];
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const options = { conversationId: "global-default", recipientBinding: "binding1" };

it("the lead settles an unresolved original by ID, and the next message to that seat is delivered without a replay", async () => {
  const f = fixture(),
    native = f.create();
  const originalId = await f.lostOriginal(native);
  // The repro: every later message is refused while the original is unresolved.
  const refused = await native.deliverToSeat("seat1", "status?", undefined, options);
  expect(refused).toMatchObject({ outcome: "undelivered" });
  expect(refused.outcome === "undelivered" && refused.detail).toContain(originalId);
  // Reading the receipt alone still changes nothing.
  expect(await f.watches().reconcileSeatDelivery(originalId, "global-default")).toMatchObject({
    outcome: "unconfirmed",
  });
  // The lead's explicit settle, scoped to its conversation.
  await expect(f.watches().settleSeatDelivery(originalId, "another-lead")).rejects.toThrow(
    "another conversation",
  );
  const settled = await f.watches().settleSeatDelivery(originalId, "global-default");
  expect(settled).toMatchObject({ outcome: "undelivered", settled: "not_delivered", messageId: originalId });
  expect(f.create().unresolvedDeliveries()).toEqual([]);
  expect(await f.deliverNext(f.create(), "status?")).toMatchObject({ outcome: "delivered" });
  // Original once, the next message once; the original was never resent.
  expect(f.sends()).toBe(2);
});

it("a lead settle that finds the original in the recipient's session records it delivered instead", async () => {
  const f = fixture(),
    native = f.create();
  const originalId = await f.lostOriginal(native);
  f.arrive("handoff: start the release");
  expect(await f.watches().settleSeatDelivery(originalId, "global-default")).toMatchObject({
    outcome: "delivered",
  });
  expect(f.create().unresolvedDeliveries()).toEqual([]);
  expect(f.sends()).toBe(1);
});

it("an original that never arrived settles on its own after a bounded wait while the recipient is idle", async () => {
  const f = fixture(),
    native = f.create();
  const originalId = await f.lostOriginal(native);
  // Inside the bound, it still blocks.
  f.advance(30_000);
  expect(await native.deliverToSeat("seat1", "status?", undefined, options)).toMatchObject({
    outcome: "undelivered",
  });
  // A busy recipient may still be about to take a queued original: no settle.
  f.advance(60_000);
  f.setStatus("working");
  expect(await native.deliverToSeat("seat1", "status?", undefined, options)).toMatchObject({
    outcome: "undelivered",
  });
  // Idle, past the bound, and still absent from its session: settled as not delivered.
  f.setStatus("idle");
  expect(await f.deliverNext(native, "status?")).toMatchObject({ outcome: "delivered" });
  expect(native.unresolvedDeliveries().map((entry) => entry.receiptId)).not.toContain(originalId);
  expect(f.sends()).toBe(2);
});

it("the bounded wait never settles an original the recipient's session shows arrived", async () => {
  const f = fixture(),
    native = f.create();
  await f.lostOriginal(native);
  f.arrive("handoff: start the release");
  f.advance(120_000);
  // VUH-2034 behavior stands: proven arrival reconciles, and the next message goes.
  expect(await f.deliverNext(native, "status?")).toMatchObject({ outcome: "delivered" });
  expect(f.sends()).toBe(2);
});

// VUH-2535: persisted state has neither beforeIds nor nativeDeliveryId when
// the service dies during dispatch and its initial remote transcript read failed.
it("restart recovery confirms exact post-dispatch transcript arrival without a baseline or channel ID", async () => {
  const f = fixture();
  const id = f.seedInterrupted();
  const native = f.create();
  f.arrive("handoff: start the release", new Date(Date.now() + 1000).toISOString());
  expect(await native.reconcileDelivery(id)).toMatchObject({
    outcome: "delivered",
    deliveryStage: "consumed",
  });
  expect(f.create().unresolvedDeliveries()).toEqual([]);
  expect(f.sends()).toBe(0);
  expect(await f.deliverNext(f.create(), "status?")).toMatchObject({ outcome: "delivered" });
});

it("restart timeout releases an unknowable receipt even for a busy seat with an unreadable transcript", async () => {
  const f = fixture();
  const id = f.seedInterrupted();
  const native = f.create();
  f.hideTranscript();
  f.setStatus("working");
  f.advance(59_999);
  expect(await native.deliverToSeat("seat1", "status?", undefined, options)).toMatchObject({
    outcome: "undelivered",
  });
  expect(native.unresolvedDeliveries()).toHaveLength(1);
  f.advance(1);
  // Retrying the original at expiry only settles it, never dispatches it.
  expect(await native.deliverToSeat("seat1", "handoff: start the release", undefined, options)).toMatchObject(
    { settled: "not_delivered" },
  );
  expect(native.unresolvedDeliveries()).toEqual([]);
  expect(
    new DeliveryFence(join(f.root, "watches.json.delivery-receipts.json"))
      .all()
      .some(
        ([, receipt]) => receipt.messageId === id && receipt.abandoned?.disposition === "abandoned-unknown",
      ),
  ).toBe(true);
  expect(f.sends()).toBe(0);
  expect(await f.deliverNext(f.create(), "status?")).toMatchObject({ outcome: "delivered" });
  expect(f.sends()).toBe(1);
});

it("restart recovery accepts the exact retained channel ACK without a transcript", async () => {
  const f = fixture();
  const id = await f.lostOriginal(f.create());
  f.mailbox.acknowledge(id, "binding1");
  f.hideTranscript();
  expect(await f.create().reconcileDelivery(id)).toMatchObject({
    outcome: "delivered",
    deliveryStage: "delivered",
  });
  expect(f.create().unresolvedDeliveries()).toEqual([]);
  expect(f.sends()).toBe(1);
});

it("an old identical transcript message cannot prove a restart-interrupted delivery arrived", async () => {
  const f = fixture();
  const id = f.seedInterrupted();
  f.arrive("handoff: start the release", new Date(Date.now() - 60_000).toISOString());
  f.arrive("handoff: start the release"); // Missing timestamps prove nothing either.
  expect(await f.create().reconcileDelivery(id)).toMatchObject({ outcome: "unconfirmed" });
  expect(f.create().unresolvedDeliveries()).toHaveLength(1);
});

it("the persisted hiring lead can settle another conversation's blocking receipt; foreign leads cannot", async () => {
  const f = fixture();
  f.hire("hiring-lead");
  const id = f.seedInterrupted();
  const watches = f.watches();
  await expect(watches.settleSeatDelivery(id, "foreign-lead")).rejects.toThrow("another conversation");
  await expect(watches.reconcileSeatDelivery(id, "hiring-lead")).rejects.toThrow("another conversation");
  expect(await watches.settleSeatDelivery(id, "hiring-lead")).toMatchObject({ settled: "not_delivered" });
  expect(f.create().unresolvedDeliveries()).toEqual([]);
  expect(await f.deliverNext(f.create(), "status?")).toMatchObject({ outcome: "delivered" });
  expect(f.sends()).toBe(1);
});

it("a replacement occupant's hiring lead cannot settle the previous occupant's receipt", async () => {
  const f = fixture();
  const id = f.seedInterrupted();
  f.changeOccupant();
  f.hire("replacement-lead");
  await expect(f.watches().settleSeatDelivery(id, "replacement-lead")).rejects.toThrow(
    "another conversation",
  );
  expect(f.create().unresolvedDeliveries()).toHaveLength(1);
  expect(f.sends()).toBe(0);
});

it("over the lead's MCP tools: message_seat is refused, reconcile_seat_call settles the original by its deliveryId, and the next message_seat is delivered", async () => {
  const { createClankieApp } = await import("../src/app.ts");
  const { createStubCaptain } = await import("../src/captain/port.ts");
  const f = fixture(),
    native = f.create();
  let nextText = "handoff: start the release";
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
                  text: JSON.stringify(await native.deliverToSeat("seat1", nextText, undefined, options)),
                },
              ],
            }),
          },
        ],
      }),
      // The same native control the lead's message_seat uses, as in one running service.
      reconcileSeatDelivery: (id) => native.reconcileDelivery(id),
      settleSeatDelivery: (id) => native.settleDelivery(id),
    }),
  });
  let session: string | undefined;
  let rpcId = 0;
  const rpc = async (method: string, params?: unknown) => {
    const response = await app.app.request("/v1/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer proof-owner",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    session ??= response.headers.get("mcp-session-id") ?? undefined;
    return response;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await (await rpc("tools/call", { name, arguments: args })).json()) as {
      result: { content: { text: string }[]; isError?: boolean; _meta?: Record<string, { id: string }> };
    };
  try {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "lead", version: "1" },
    });
    await app.app.request("/v1/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer proof-owner",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": session!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    // The original: taken by the bridge, never acknowledged, never in the session.
    const poll = f.mailbox.poll(1000, undefined, "binding1");
    const sent = call("message_seat");
    await poll;
    const original = await sent;
    expect(JSON.parse(original.result.content[0]!.text)).toMatchObject({ outcome: "unconfirmed" });
    const deliveryId = original.result._meta!["clankie/seat-call"]!.id;
    // The repro: the lead's next message_seat to that seat is refused.
    nextText = "Ash pushed; you're next in the landing order.";
    expect(JSON.parse((await call("message_seat")).result.content[0]!.text)).toMatchObject({
      outcome: "undelivered",
    });
    // Reading alone settles nothing; settle needs the explicit choice.
    expect(
      JSON.parse((await call("reconcile_seat_call", { deliveryId })).result.content[0]!.text),
    ).toMatchObject({
      outcome: "unconfirmed",
    });
    expect(
      (await call("reconcile_seat_call", { hireId: deliveryId, settle: "not_delivered" })).result.isError,
    ).toBe(true);
    const settled = await call("reconcile_seat_call", { deliveryId, settle: "not_delivered" });
    expect(JSON.parse(settled.result.content[0]!.text)).toMatchObject({
      outcome: "undelivered",
      settled: "not_delivered",
    });
    // New messages resume; the original is never resent.
    const nextPoll = f.mailbox.poll(1000, undefined, "binding1");
    const next = call("message_seat");
    const [event] = await nextPoll;
    expect(event!.content).toContain("you're next in the landing order");
    f.mailbox.acknowledge(event!.id, "binding1");
    expect(JSON.parse((await next).result.content[0]!.text)).toMatchObject({ outcome: "delivered" });
    expect(f.sends()).toBe(2);
  } finally {
    app.close();
  }
});
