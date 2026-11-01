import { readPersistedConversation } from "./support/persisted-conversation.ts";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { FleetSeatMessageSchema, WorkerReportPageSchema } from "@clankie/protocol";
import { ConversationStore } from "../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { InboundAcceptanceSchema } from "../src/captain/conversations/constants.ts";

// Passthrough namespace permits faulting only the selected commit operation.
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));

const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(() => {
  vi.useRealTimers();
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "inbound-report-recovery-"));
  roots.push(root);
  return root;
}
async function crash(root: string, mode: "queued" | "attempting", deliveryId: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
      fileURLToPath(new URL("./support/inbound-report-process.ts", import.meta.url)),
      root,
      mode,
      deliveryId,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  children.add(child);
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Service fixture never reached ${mode}: ${stderr}`)),
      10_000,
    );
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Service fixture exited: ${stderr}`));
    });
    child.once("message", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exit;
  children.delete(child);
}

it("retains a truly queued report through abrupt service death, retries the original ID and needs explicit read acknowledgment", async () => {
  const root = fixtureRoot();
  const deliveryId = randomUUID();
  await crash(root, "queued", deliveryId);
  const delivered: string[] = [];
  const store = new ConversationStore(join(root, "conversations"), async () => {
    throw new Error("Recovery must use its host-admitted report runner");
  });
  expect(store.inboundReports()).toMatchObject([{ deliveryId, reportDelivery: { state: "pending" } }]);
  const accepted = store.retryInboundReport(deliveryId, async (_id, text, _publish, context) => {
    delivered.push(text);
    context.deliveryReceipt?.("delivered");
  });
  expect(accepted?.status).toBe("accepted");
  expect(store.retryInboundReport(deliveryId, async () => {})).toBeUndefined();
  await store.close();
  expect(delivered).toEqual(["report"]);
  expect(store.inboundReports()).toMatchObject([
    { deliveryId, reportDelivery: { state: "delivered", stage: "delivered" } },
  ]);
  expect(store.acknowledgeInboundReports("global-default", [deliveryId])).toBe(false);
  const page = WorkerReportPageSchema.parse(store.readInboundReports("global-default"));
  expect(page).toMatchObject({
    unreadCount: 1,
    ackDeliveryIds: [deliveryId],
    items: [{ deliveryId, text: "report" }],
  });
  expect(store.inboundReports()).toHaveLength(1);
  const restarted = new ConversationStore(join(root, "conversations"), async () => {});
  expect(restarted.acknowledgeInboundReports("global-default", [deliveryId])).toBe(true);
  expect(restarted.inboundReports()).toEqual([]);
  expect(restarted.inboundReports(undefined, { includeRead: true })).toMatchObject([
    { reportDelivery: { state: "read" } },
  ]);
  await restarted.close();
});

it("keeps an interrupted native handoff uncertain and does not replay it or equate consumption with reading", async () => {
  const root = fixtureRoot();
  const deliveryId = randomUUID();
  await crash(root, "attempting", deliveryId);
  const store = new ConversationStore(join(root, "conversations"), async () => {});
  expect(store.inboundReports()).toMatchObject([{ deliveryId, reportDelivery: { state: "uncertain" } }]);
  expect(
    store.retryInboundReport(deliveryId, async () => {
      throw new Error("Must never run");
    }),
  ).toBeUndefined();
  store.recordInboundReportDelivery(deliveryId, "consumed");
  expect(store.inboundReports()).toMatchObject([
    { deliveryId, reportDelivery: { state: "delivered", stage: "consumed" } },
  ]);
  expect(store.acknowledgeInboundReports("other-conversation", [deliveryId])).toBe(false);
  await store.close();
});

it("keeps original admitted recipients and legacy interrupted reports visible after restart and context reset", async () => {
  const root = fixtureRoot();
  const conversationRoot = join(root, "conversations");
  const store = new ConversationStore(conversationRoot, async () => {});
  const delivery = { id: randomUUID(), binding: "a".repeat(64) };
  const receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
  expect(
    receipts.accept(
      "w3Z:pR",
      delivery,
      "finished",
      "worker output: finished",
      "global-default",
      async (_id, _text, _publish, context) => {
        context.deliveryReceipt?.("unavailable");
        throw new Error("Lead is disconnected");
      },
      { source: "adoption", conversationId: "global-default" },
      { kind: "conversation", owner: { conversationId: "global-default" } },
    ),
  ).toMatchObject({ received: true });
  await store.close();
  const metaPath = join(conversationRoot, "global-default/meta.json");
  const metadata = readPersistedConversation(metaPath);
  delete metadata.inboundAcceptances[delivery.id].reportDelivery;
  delete metadata.inboundAcceptances[delivery.id].acceptedAt;
  writeFileSync(metaPath, JSON.stringify(metadata));
  const restarted = new ConversationStore(conversationRoot, async () => {});
  expect(restarted.inboundReports()).toMatchObject([
    {
      deliveryId: delivery.id,
      recipient: { kind: "conversation", owner: { conversationId: "global-default" } },
      reportDelivery: { state: "uncertain" },
    },
  ]);
  const conversation = restarted.conversation("global-default")!;
  const reset = await restarted.serve({
    schemaVersion: 1,
    op: "reset",
    conversationId: "global-default",
    expectedRevision: conversation.revision,
  });
  expect(reset.op).toBe("reset");
  expect(restarted.inboundAcceptance(delivery.id)?.fingerprint).toBe(deliveryFingerprint("finished"));
  expect(restarted.readInboundReports("global-default").unreadCount).toBe(1);
  expect(restarted.acknowledgeInboundReports("global-default", [delivery.id, randomUUID()])).toBe(false);
  expect(restarted.inboundReports()).toHaveLength(1);
  await restarted.close();
});

it("bounds full report reads and never acknowledges reports omitted from the page", async () => {
  const root = fixtureRoot();
  const store = new ConversationStore(join(root, "conversations"), async (_id, _text, _publish, context) => {
    context.deliveryReceipt?.("unavailable");
  });
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    const text = String(index) + "\u0000".repeat(16_383);
    store.submitInbound(text, {
      deliveryId: id,
      binding: "a".repeat(64),
      fingerprint: deliveryFingerprint(text),
      paneId: "w3Z:pR",
      text,
    });
  }
  await store.close();
  const page = WorkerReportPageSchema.parse(store.readInboundReports("global-default"));
  expect(page.unreadCount).toBe(2);
  expect(page.items).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(128 * 1024);
  const offered = page.ackDeliveryIds[0]!;
  const omitted = ids.find((id) => id !== offered)!;
  expect(store.acknowledgeInboundReports("global-default", [offered, omitted])).toBe(false);
  expect(store.acknowledgeInboundReports("global-default", [offered])).toBe(true);
  expect(store.inboundReports()).toMatchObject([{ deliveryId: omitted }]);
});

it.each(["界".repeat(16_384), "\u0000".repeat(16_384)])(
  "offers and acknowledges an exact maximum-length multilingual or JSON-escaped report after restart",
  async (text) => {
    const root = fixtureRoot();
    const conversationRoot = join(root, "conversations");
    const store = new ConversationStore(conversationRoot, async (_id, _text, _publish, context) => {
      context.deliveryReceipt?.("unavailable");
    });
    const delivery = { id: randomUUID(), binding: "a".repeat(64) };
    const admitted = FleetSeatMessageSchema.parse({ schemaVersion: 1, text, delivery });
    const receiptPath = join(root, "inbound.json");
    expect(
      new InboundSeatReceipts(receiptPath, store).accept(
        "w3Z:pR",
        delivery,
        admitted.text,
        `Worker output:\n${admitted.text}`,
      ),
    ).toMatchObject({ received: true });
    await store.close();
    const later = { id: randomUUID(), binding: delivery.binding };
    const restarted = new ConversationStore(conversationRoot, async (_id, _text, _publish, context) => {
      context.deliveryReceipt?.("unavailable");
    });
    expect(
      new InboundSeatReceipts(receiptPath, restarted).accept(
        "w3Z:pR",
        later,
        "later report",
        "Worker output: later report",
      ),
    ).toMatchObject({ received: true });
    await restarted.close();
    const page = WorkerReportPageSchema.parse(restarted.readInboundReports("global-default", { limit: 1 }));
    expect(page.items).toMatchObject([{ deliveryId: delivery.id, text }]);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(128 * 1024);
    expect(restarted.acknowledgeInboundReports("global-default", page.ackDeliveryIds)).toBe(true);
    const next = WorkerReportPageSchema.parse(restarted.readInboundReports("global-default"));
    expect(next.items).toMatchObject([{ deliveryId: later.id, text: "later report" }]);
    expect(restarted.acknowledgeInboundReports("global-default", next.ackDeliveryIds)).toBe(true);
    expect(restarted.inboundReports()).toEqual([]);
  },
);

it("preserves the original acceptance timestamp and offered acknowledgment proof while retrying the exact report", async () => {
  const root = fixtureRoot();
  const store = new ConversationStore(join(root, "conversations"), async (_id, _text, _publish, context) => {
    context.deliveryReceipt?.("unavailable");
  });
  const deliveryId = randomUUID();
  const text = "original report";
  store.submitInbound(text, {
    deliveryId,
    binding: "a".repeat(64),
    fingerprint: deliveryFingerprint(text),
    paneId: "w3Z:pR",
    text,
  });
  await store.close();
  const page = WorkerReportPageSchema.parse(store.readInboundReports("global-default"));
  const original = store.inboundAcceptance(deliveryId)!;
  expect(
    store.retryInboundReport(deliveryId, async (_id, prompt, _publish, context) => {
      expect(prompt).toBe(text);
      context.deliveryReceipt?.("delivered");
    })?.status,
  ).toBe("accepted");
  await store.close();
  const retried = store.inboundAcceptance(deliveryId)!;
  expect(retried.acceptedAt).toBe(original.acceptedAt);
  expect(retried.reportDelivery?.offeredAt).toBe(original.reportDelivery?.offeredAt);
  expect(retried.runId).not.toBe(original.runId);
  expect(store.acknowledgeInboundReports("global-default", page.ackDeliveryIds)).toBe(true);
});

it("does not dispatch a queued report after its recipient has explicitly read it", async () => {
  const root = fixtureRoot();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const invoked: string[] = [];
  const store = new ConversationStore(join(root, "conversations"), async (_id, text) => {
    invoked.push(text);
    await held;
  });
  store.submitInternal("global-default", "held turn", "wake");
  const deliveryId = randomUUID();
  store.submitInbound("report", {
    deliveryId,
    binding: "a".repeat(64),
    fingerprint: deliveryFingerprint("report"),
    paneId: "w3Z:pR",
    text: "report",
  });
  store.readInboundReports("global-default");
  expect(store.acknowledgeInboundReports("global-default", [deliveryId])).toBe(true);
  release();
  await store.close();
  expect(invoked).toEqual(["held turn"]);
  expect(store.inboundReports()).toEqual([]);
});

it("VUH-2216: a worker's poll validates only its own retained reports", async () => {
  const root = fixtureRoot();
  const store = new ConversationStore(join(root, "conversations"), async () => {});
  const receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
  const binding = "a".repeat(64);
  for (let report = 0; report < 10; report++)
    receipts.accept(
      "busy-pane",
      { id: randomUUID(), binding },
      `busy ${report}`,
      `busy ${report}`,
      "global-default",
      async () => {},
    );
  receipts.accept("pane", { id: randomUUID(), binding }, "mine", "mine", "global-default", async () => {});
  const parse = vi.spyOn(InboundAcceptanceSchema, "parse");
  try {
    // Every worker poll asks for its own receipt events; others' payloads stay unparsed.
    expect(store.senderReportEvents("pane", binding)).toHaveLength(1);
    expect(parse).toHaveBeenCalledOnce();
    parse.mockRestore();
    const busy = store.senderReportEvents("busy-pane", binding);
    // Ten receipts reach a busy pane as one line, not ten (#97).
    expect(busy).toHaveLength(1);
    expect(busy[0]?.content).toContain("Stored 10 of your reports");
    expect(store.inboundReports()).toHaveLength(11);
  } finally {
    parse.mockRestore();
    await store.close();
  }
});

it("#97: acknowledging a pile of old reports tells the worker once", async () => {
  const root = fixtureRoot();
  const store = new ConversationStore(join(root, "conversations"), async () => {});
  const receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
  const binding = "a".repeat(64);
  for (let report = 0; report < 44; report++)
    receipts.accept(
      "pane",
      { id: randomUUID(), binding },
      `old ${report}`,
      `old ${report}`,
      "global-default",
      async () => {},
    );
  // The worker's link already told it each report was stored.
  for (const event of store.senderReportEvents("pane", binding))
    expect(store.acknowledgeSenderReportEvent("pane", binding, event.id)).toBe(true);
  expect(store.senderReportEvents("pane", binding)).toEqual([]);
  const page = store.readInboundReports("global-default");
  expect(store.acknowledgeInboundReports("global-default", page.ackDeliveryIds)).toBe(true);
  const events = store.senderReportEvents("pane", binding);
  expect(events).toHaveLength(1);
  expect(events[0]?.content.split("\n")).toEqual([
    expect.stringContaining(`Clankie acknowledged ${page.ackDeliveryIds.length} of your reports`),
    expect.stringContaining("No reply from Clankie has reached you for them"),
    "Receipt only; no reply needed.",
  ]);
  expect(store.acknowledgeSenderReportEvent("pane", binding, events[0]!.id)).toBe(true);
  expect(store.senderReportEvents("pane", binding)).toEqual([]);
  // The link retries an acknowledgment whose answer it lost; the retry still succeeds.
  expect(store.acknowledgeSenderReportEvent("pane", binding, events[0]!.id)).toBe(true);
  expect(
    store.acknowledgeSenderReportEvent(
      "pane",
      binding,
      "report:batch:2000-01-01T00:00:00.000Z:0123456789abcdef",
    ),
  ).toBe(false);
  // A report sent after the batch is still told on its own.
  receipts.accept("pane", { id: randomUUID(), binding }, "new", "new", "global-default", async () => {});
  expect(store.senderReportEvents("pane", binding)).toEqual([
    expect.objectContaining({ content: expect.stringContaining("stored") }),
  ]);
  await store.close();
});

it("#97: a batch acknowledged after its reports moved on still counts", async () => {
  const root = fixtureRoot();
  const store = new ConversationStore(join(root, "conversations"), async () => {});
  const receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
  const binding = "b".repeat(64);
  for (let report = 0; report < 3; report++)
    receipts.accept(
      "pane",
      { id: randomUUID(), binding },
      `r ${report}`,
      `r ${report}`,
      "global-default",
      async () => {},
    );
  const [stored] = store.senderReportEvents("pane", binding);
  expect(stored?.content).toContain("Stored 3 of your reports");
  // The lead reads them before the worker's acknowledgment of the stored batch lands.
  const page = store.readInboundReports("global-default");
  expect(store.acknowledgeInboundReports("global-default", page.ackDeliveryIds)).toBe(true);
  expect(store.acknowledgeSenderReportEvent("pane", binding, stored!.id)).toBe(true);
  const [next, ...rest] = store.senderReportEvents("pane", binding);
  expect(rest).toEqual([]);
  expect(next?.id).not.toBe(stored!.id);
  expect(next?.content).toContain("Clankie acknowledged 3 of your reports");
  expect(store.acknowledgeSenderReportEvent("pane", binding, next!.id)).toBe(true);
  expect(store.senderReportEvents("pane", binding)).toEqual([]);
  // The stored batch retried late is still answered as done.
  expect(store.acknowledgeSenderReportEvent("pane", binding, stored!.id)).toBe(true);
  await store.close();
});

it("#97: a batch acknowledged after a stage landed in its same millisecond tells that stage again", async () => {
  const root = fixtureRoot();
  const store = new ConversationStore(join(root, "conversations"), async () => {});
  const receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
  const binding = "c".repeat(64);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-11-01T07:00:00.000Z"));
    for (let report = 0; report < 2; report++)
      receipts.accept(
        "pane",
        { id: randomUUID(), binding },
        `r ${report}`,
        `r ${report}`,
        "global-default",
        async () => {},
      );
    const [stored] = store.senderReportEvents("pane", binding);
    expect(stored?.content).toContain("Stored 2 of your reports");
    // The lead reads them in the batch's own millisecond, after the batch went out.
    const page = store.readInboundReports("global-default");
    expect(store.acknowledgeInboundReports("global-default", page.ackDeliveryIds)).toBe(true);
    expect(store.acknowledgeSenderReportEvent("pane", binding, stored!.id)).toBe(true);
    // The acknowledgment the batch never carried is still told, not dropped.
    expect(store.senderReportEvents("pane", binding)).toEqual([
      expect.objectContaining({ content: expect.stringContaining("Clankie acknowledged 2 of your reports") }),
    ]);
  } finally {
    vi.useRealTimers();
  }
  await store.close();
});

it.each(["unadopted", "adoption"] as const)(
  "retains immediately resolvable %s receipts and sender stage events across reconnect",
  async (source) => {
    const root = fixtureRoot();
    const directory = join(root, "conversations");
    const store = new ConversationStore(directory, async () => {});
    const receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
    const delivery = { id: randomUUID(), binding: "a".repeat(64) };
    const refused = receipts.refuse(
      "refused-pane",
      { id: randomUUID(), binding: delivery.binding },
      "refused",
    );
    expect(receipts.status("refused-pane", delivery.binding, refused.deliveryId)).toMatchObject({
      deliveryStage: "unavailable",
    });
    expect(receipts.status("pane", delivery.binding, refused.deliveryId)).toBeUndefined();
    const sent = receipts.accept("pane", delivery, "handoff", "handoff", "global-default", async () => {}, {
      source,
    });
    expect(sent.received).toBe(true);
    expect(receipts.status("pane", delivery.binding, sent.deliveryId)).toMatchObject({
      deliveryStage: "stored",
    });
    expect(receipts.status("other", delivery.binding, sent.deliveryId)).toBeUndefined();
    expect(receipts.status("pane", "b".repeat(64), sent.deliveryId)).toBeUndefined();
    const stored = store.senderReportEvents("pane", delivery.binding);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toContain("stored");
    expect(store.senderReportEvents("pane", "b".repeat(64))).toEqual([]);
    expect(store.acknowledgeSenderReportEvent("pane", "b".repeat(64), stored[0]!.id)).toBe(false);
    expect(store.acknowledgeSenderReportEvent("pane", delivery.binding, stored[0]!.id)).toBe(true);
    expect(store.inboundReports()).toHaveLength(1);
    store.recordInboundReportDelivery(sent.deliveryId, "consumed");
    const taken = store.senderReportEvents("pane", delivery.binding);
    store.recordInboundReportDelivery(sent.deliveryId, "uncertain");
    expect(store.senderReportEvents("pane", delivery.binding)).toEqual(taken);
    const page = store.readInboundReports("global-default");
    expect(store.senderReportEvents("pane", delivery.binding)[0]?.content).toContain(
      "taken into a lead turn",
    );
    const link = "https://linear.app/vuhlp/issue/VUH-1898";
    // The lead's reply reached the worker, so its summary is relayed (VUH-2065).
    store.recordInboundReportReply("global-default", "pane", delivery.binding);
    expect(
      store.acknowledgeInboundReports("global-default", page.ackDeliveryIds, {
        summary: "Filed the follow-up.",
        links: [link],
      }),
    ).toBe(true);
    const events = store.senderReportEvents("pane", delivery.binding);
    // The acknowledgment supersedes the untold "taken" stage: one line, not two (#97).
    expect(events).toHaveLength(1);
    expect(events[0]?.content).toContain("acknowledged");
    expect(events[0]?.content).toContain(link);
    expect(events[0]?.content).toContain("Filed the follow-up.");
    await store.close();
    const reopened = new ConversationStore(directory, async () => {});
    expect(reopened.senderReportEvents("pane", delivery.binding)).toEqual(events);
    for (const event of events)
      expect(reopened.acknowledgeSenderReportEvent("pane", delivery.binding, event.id)).toBe(true);
    expect(reopened.senderReportEvents("pane", delivery.binding)).toEqual([]);
    expect(reopened.acknowledgeInboundReports("global-default", page.ackDeliveryIds)).toBe(true);
    expect(reopened.senderReportEvents("pane", delivery.binding)).toEqual([]);
    await reopened.close();
  },
);

it("keeps unread reports and reports read within a day, and lets older read reports age out of saved metadata (VUH-2410)", async () => {
  const root = fixtureRoot();
  const conversationRoot = join(root, "conversations");
  const start = new Date("2026-10-17T12:00:00.000Z");
  vi.useFakeTimers({ toFake: ["Date"], now: start });
  try {
    const store = new ConversationStore(conversationRoot, async (_id, _text, _publish, context) => {
      context.deliveryReceipt?.("delivered");
    });
    const receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
    const binding = "a".repeat(64);
    const send = (text: string) => {
      const delivery = { id: randomUUID(), binding };
      expect(
        receipts.accept(
          "w3Z:pR",
          delivery,
          text,
          `worker output: ${text}`,
          "global-default",
          async (_id, _body, _publish, context) => context.deliveryReceipt?.("delivered"),
          { source: "adoption", conversationId: "global-default" },
          { kind: "conversation", owner: { conversationId: "global-default" } },
        ),
      ).toMatchObject({ received: true });
      return delivery.id;
    };
    const oldRead = send("read long ago");
    const unread = send("never read");
    const recentRead = send("read just now");
    await store.close();
    expect(store.acknowledgeInboundReports("global-default", [oldRead])).toBe(false);
    expect(store.readInboundReports("global-default", { deliveryIds: [oldRead] }).ackDeliveryIds).toEqual([
      oldRead,
    ]);
    expect(store.acknowledgeInboundReports("global-default", [oldRead])).toBe(true);

    // A day and an hour later the lead reads another report; that save drops only the stale read one.
    vi.setSystemTime(new Date(start.getTime() + 25 * 3_600_000));
    expect(store.readInboundReports("global-default", { deliveryIds: [recentRead] }).ackDeliveryIds).toEqual([
      recentRead,
    ]);
    expect(store.acknowledgeInboundReports("global-default", [recentRead])).toBe(true);
    expect(store.inboundAcceptance(oldRead)).toBeUndefined();
    // Its exact-ID status no longer proves anything, and never claims it was not sent.
    const aged = receipts.status("w3Z:pR", binding, oldRead);
    expect(aged === undefined || (aged.deliveryStage === "uncertain" && aged.definitive === undefined)).toBe(
      true,
    );
    expect(receipts.status("w3Z:pR", binding, recentRead)).toMatchObject({ deliveryStage: "consumed" });
    expect(receipts.status("w3Z:pR", binding, unread)).toMatchObject({ deliveryStage: "delivered" });

    const saved = readFileSync(join(conversationRoot, "global-default/meta.json"), "utf8");
    expect(saved).not.toContain("\n");
    expect(saved).not.toContain(oldRead);
    const restarted = new ConversationStore(conversationRoot, async () => {});
    expect(
      restarted
        .inboundReports(undefined, { includeRead: true })
        .map((report) => report.deliveryId)
        .sort(),
    ).toEqual([unread, recentRead].sort());
    // An unread report is never dropped, however old.
    vi.setSystemTime(new Date(start.getTime() + 30 * 24 * 3_600_000));
    restarted.recordInboundReportDelivery(unread, "consumed");
    expect(restarted.readInboundReports("global-default")).toMatchObject({
      unreadCount: 1,
      items: [{ deliveryId: unread, text: "never read" }],
    });
    await restarted.close();
  } finally {
    vi.useRealTimers();
  }
});

it("migrates a large retained inbox into committed shards, compacts only expired read reports and coalesces native stage repeats", async () => {
  const root = fixtureRoot();
  const directory = join(root, "conversations");
  let store = new ConversationStore(directory, async () => {});
  let receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
  const binding = "a".repeat(64);
  const first = randomUUID();
  receipts.accept(
    "pane",
    { id: first, binding },
    "report",
    "worker report",
    "global-default",
    async (_id, _text, _publish, context) => {
      context.deliveryReceipt?.("delivered");
    },
  );
  await store.close();
  const path = join(directory, "global-default", "meta.json");
  const metadata = readPersistedConversation(path);
  const original = metadata.inboundAcceptances[first];
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const ids = Array.from({ length: 512 }, () => randomUUID());
  metadata.inboundAcceptances = Object.fromEntries(
    ids.map((id, index) => [
      id,
      {
        ...original,
        deliveryId: id,
        runId: randomUUID(),
        acceptedAt: old,
        fingerprint: deliveryFingerprint(`retained ${index} ` + "t".repeat(6144)),
        text: `retained ${index} ` + "t".repeat(6144),
        message: `retained ${index} ` + "m".repeat(6144),
        reportDelivery:
          index < 100
            ? { state: "read", stage: "delivered", readAt: old }
            : index < 400
              ? { state: "delivered", stage: "delivered", deliveredAt: old }
              : { state: "uncertain", stage: "uncertain" },
      },
    ]),
  );
  writeFileSync(path, JSON.stringify(metadata));
  expect(statSync(path).size).toBeGreaterThan(6_000_000);
  store = new ConversationStore(directory, async () => {});
  receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
  expect(store.inboundReportSummaries()).toHaveLength(412);
  const committed = JSON.parse(readFileSync(path, "utf8"));
  expect(committed.inboundAcceptances).toBeUndefined();
  expect(committed.inboundReportStore.version).toBe(1);
  expect(statSync(path).size).toBeLessThan(50_000);
  expect(store.inboundAcceptance(ids[0]!)).toBeUndefined();
  for (const index of [100, 399, 400, 511])
    expect(store.inboundAcceptance(ids[index]!)).toMatchObject({
      deliveryId: ids[index],
      text: metadata.inboundAcceptances[ids[index]!].text,
      reportDelivery: { state: index < 400 ? "delivered" : "uncertain" },
    });
  const next = randomUUID();
  expect(
    receipts.accept(
      "pane",
      { id: next, binding },
      "new report",
      "new worker report",
      "global-default",
      async (_id, _text, _publish, context) => {
        context.deliveryReceipt?.("delivered");
      },
    ),
  ).toMatchObject({ received: true });
  await store.close();
  const after = JSON.parse(readFileSync(path, "utf8"));
  expect(
    Object.values(after.inboundReportStore.shards).filter(
      (file) => !Object.values(committed.inboundReportStore.shards).includes(file),
    ),
  ).toHaveLength(1);
  store = new ConversationStore(directory, async () => {});
  const identity = statSync(path, { bigint: true });
  for (let index = 0; index < 20; index++)
    expect(store.recordInboundReportDelivery(next, "delivered")).toBe(true);
  expect(statSync(path, { bigint: true }).ino).toBe(identity.ino);
  expect(statSync(path, { bigint: true }).mtimeNs).toBe(identity.mtimeNs);
  const firstOffer = store.readInboundReports("global-default", { deliveryIds: [next] });
  const offeredIdentity = statSync(path, { bigint: true });
  const firstTake = store.inboundAcceptance(next)!.reportDelivery!;
  for (let index = 0; index < 20; index++)
    expect(store.readInboundReports("global-default", { deliveryIds: [next] })).toEqual(firstOffer);
  expect(store.inboundAcceptance(next)!.reportDelivery).toEqual(firstTake);
  expect(statSync(path, { bigint: true }).ino).toBe(offeredIdentity.ino);
  expect(statSync(path, { bigint: true }).mtimeNs).toBe(offeredIdentity.mtimeNs);
  expect(store.inboundReportSummaries()).toHaveLength(413);
  expect(store.inboundAcceptance(ids[511]!)).toMatchObject({
    text: metadata.inboundAcceptances[ids[511]!].text,
  });
  await store.close();
});

it("fails closed on a missing or corrupt committed report shard without replacing the unread inbox", async () => {
  const root = fixtureRoot();
  const directory = join(root, "conversations");
  const store = new ConversationStore(directory, async () => {});
  const id = randomUUID();
  const receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
  receipts.accept(
    "pane",
    { id, binding: "a".repeat(64) },
    "unread report",
    "unread report",
    "global-default",
    async () => {},
  );
  await store.close();
  const path = join(directory, "global-default", "meta.json");
  const body = readFileSync(path, "utf8");
  const manifest = JSON.parse(body).inboundReportStore;
  const shard = join(
    directory,
    "global-default",
    "inbound-reports",
    String(Object.values(manifest.shards)[0]),
  );
  const bytes = readFileSync(shard);
  writeFileSync(shard, "corrupt");
  expect(() => new ConversationStore(directory, async () => {})).toThrow(
    "Retained inbound reports are unreadable",
  );
  expect(readFileSync(path, "utf8")).toBe(body);
  rmSync(shard);
  expect(() => new ConversationStore(directory, async () => {})).toThrow(
    "Retained inbound reports are unreadable",
  );
  expect(readFileSync(path, "utf8")).toBe(body);
  writeFileSync(shard, bytes);
  const recovered = new ConversationStore(directory, async () => {});
  expect(recovered.inboundReports()).toMatchObject([{ deliveryId: id, text: "unread report" }]);
  await recovered.close();
});

it("rolls back a pre-manifest failure without losing expired-read or unread receipt state", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const root = fixtureRoot();
  const directory = join(root, "conversations");
  const store = new ConversationStore(directory, async () => {});
  const receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids)
    receipts.accept(
      "pane",
      { id, binding: "a".repeat(64) },
      id,
      id,
      "global-default",
      async (_id, _text, _publish, context) => {
        context.deliveryReceipt?.("delivered");
      },
    );
  await store.close();
  store.readInboundReports("global-default", { deliveryIds: [ids[0]!] });
  expect(store.acknowledgeInboundReports("global-default", [ids[0]!])).toBe(true);
  const path = join(directory, "global-default", "meta.json");
  const committed = readFileSync(path, "utf8");
  const before = store.inboundReports(undefined, { includeRead: true });
  const rename = fs.renameSync;
  vi.setSystemTime(Date.now() + 25 * 3_600_000);
  const failure = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
    if (String(target) === path) throw new Error("fixture manifest commit unavailable");
    rename(source, target);
  });
  try {
    expect(() => store.recordInboundReportDelivery(ids[1]!, "consumed")).toThrow(
      "fixture manifest commit unavailable",
    );
    expect(readFileSync(path, "utf8")).toBe(committed);
    expect(store.inboundReports(undefined, { includeRead: true })).toEqual(before);
    expect(store.inboundAcceptance(ids[0]!)).toMatchObject({ reportDelivery: { state: "read" } });
  } finally {
    failure.mockRestore();
    vi.useRealTimers();
  }
  await store.close();
});

it("keeps a renamed inbound admission visible after directory-sync uncertainty without executing its runner", async () => {
  const root = fixtureRoot();
  const directory = join(root, "conversations");
  let calls = 0;
  const store = new ConversationStore(directory, async () => {
    calls++;
  });
  const receipts = new InboundSeatReceipts(join(root, "inbound.json"), store);
  const path = join(directory, "global-default", "meta.json");
  const rename = fs.renameSync;
  const sync = fs.fsyncSync;
  let renamed = false;
  const renameProbe = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
    rename(source, target);
    if (String(target) === path) renamed = true;
  });
  const failure = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    if (renamed) throw new Error("fixture post-rename sync unavailable");
    sync(fd);
  });
  const id = randomUUID();
  try {
    const accepted = receipts.accept(
      "pane",
      { id, binding: "a".repeat(64) },
      "retained despite sync uncertainty",
      "retained despite sync uncertainty",
      "global-default",
      async () => {
        calls++;
      },
    );
    expect(renamed).toBe(true);
    expect(accepted.definitive).not.toBe("not_sent");
    expect(store.inboundReports()).toMatchObject([
      { deliveryId: id, text: "retained despite sync uncertainty" },
    ]);
    expect(store.inboundAcceptance(id)).toMatchObject({ deliveryId: id });
    expect(calls).toBe(0);
  } finally {
    failure.mockRestore();
    renameProbe.mockRestore();
    await store.close();
  }
  const restarted = new ConversationStore(directory, async () => {
    calls++;
  });
  expect(restarted.inboundReports()).toMatchObject([
    { deliveryId: id, text: "retained despite sync uncertainty" },
  ]);
  await restarted.close();
  expect(calls).toBe(0);
});
