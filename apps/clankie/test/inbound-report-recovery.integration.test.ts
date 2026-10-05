import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { FleetSeatMessageSchema, WorkerReportPageSchema } from "@clankie/protocol";
import { ConversationStore } from "../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { deliveryFingerprint } from "../src/captain/delivery-fence.ts";

const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(() => {
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
  const metadata = JSON.parse(readFileSync(metaPath, "utf8"));
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
