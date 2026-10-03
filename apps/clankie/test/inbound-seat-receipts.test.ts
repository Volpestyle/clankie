import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { deliveryFingerprint } from "../src/captain/delivery-fence.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inbound-acceptance-"));
  roots.push(root);
  const runner = vi.fn(async () => {});
  const store = () => new ConversationStore(join(root, "conversations"), runner);
  const original = { id: randomUUID(), binding: "a".repeat(64) };
  const fence = join(root, "inbound.json");
  return {
    root,
    runner,
    store,
    original,
    fence,
    create: (conversations: ConversationStore) => new InboundSeatReceipts(fence, conversations),
  };
}
it("deduplicates exact acceptance across service replacement and blocks mismatched payload, pane and binding", async () => {
  const f = fixture();
  const store = f.store();
  const receipts = f.create(store);
  expect(receipts.accept("p1", f.original, "hello", "untrusted agent: hello")).toMatchObject({
    received: true,
    deliveryStage: "stored",
  });
  await store.close();
  expect(f.runner).toHaveBeenCalledTimes(1);
  const restarted = f.create(f.store());
  expect(restarted.accept("p1", f.original, "hello", "ignored replacement").received).toBe(true);
  expect(restarted.accept("p1", f.original, "different", "different").deliveryStage).toBe("uncertain");
  expect(restarted.reconcile("other", f.original, deliveryFingerprint("hello")).received).toBe(false);
  expect(
    restarted.reconcile("p1", { ...f.original, binding: "b".repeat(64) }, deliveryFingerprint("hello"))
      .received,
  ).toBe(false);
  expect(f.runner).toHaveBeenCalledTimes(1);
});
it("persists the pending crash window and accepts only late exact original evidence, never a new ID", () => {
  const f = fixture();
  const store = f.store();
  vi.spyOn(store, "submitInbound").mockImplementationOnce(() => {
    throw new Error("crash before acceptance");
  });
  expect(f.create(store).accept("p1", f.original, "hello", "hello").deliveryStage).toBe("uncertain");
  const restartedStore = f.store();
  const restarted = f.create(restartedStore);
  expect(restarted.accept("p1", { ...f.original, id: randomUUID() }, "hello", "hello").received).toBe(false);
  expect(restarted.accept("p1", f.original, "hello", "hello").received).toBe(false);
  expect(f.runner).not.toHaveBeenCalled();
  // Simulate a late original acceptance, never a redelivery from the guard.
  restartedStore.submitInbound("hello", {
    deliveryId: f.original.id,
    binding: f.original.binding,
    fingerprint: deliveryFingerprint("hello"),
    paneId: "p1",
    text: "hello",
  });
  expect(restarted.reconcile("p1", f.original, deliveryFingerprint("hello")).deliveryStage).toBe("stored");
  return restartedStore.close();
});
it("recovers accepted history after a crash between metadata and event append without running the stored payload", async () => {
  const f = fixture();
  const store = f.store();
  vi.spyOn(ConversationJournal.prototype, "append").mockImplementationOnce(() => {
    throw new Error("crash after metadata");
  });
  expect(f.create(store).accept("p1", f.original, "hello", "untrusted hello").deliveryStage).toBe(
    "uncertain",
  );
  expect(f.runner).not.toHaveBeenCalled();
  const restartedStore = f.store();
  expect(
    f.create(restartedStore).reconcile("p1", f.original, deliveryFingerprint("hello")).deliveryStage,
  ).toBe("stored");
  const events = new ConversationJournal(join(f.root, "conversations")).read("global-default");
  expect(events.filter((e) => e.type === "turn")).toMatchObject([
    { phase: "accepted", deliveryStage: "stored" },
    { phase: "failed", reasonCode: "service_restarted" },
  ]);
  await restartedStore.close();
  expect(f.runner).not.toHaveBeenCalled();
  const metadata = JSON.parse(readFileSync(join(f.root, "conversations/global-default/meta.json"), "utf8"));
  expect(metadata.inboundAcceptances[f.original.id]).toMatchObject({
    text: "hello",
    message: "untrusted hello",
  });
});
it.each(["fence", "acceptance"])("fails closed on corrupt %s evidence", async (kind) => {
  const f = fixture();
  const store = f.store();
  expect(f.create(store).accept("p1", f.original, "hello", "hello").received).toBe(true);
  await store.close();
  writeFileSync(
    kind === "fence" ? f.fence : join(f.root, "conversations/global-default/meta.json"),
    "corrupt",
  );
  const restarted = f.create(store);
  expect(restarted.reconcile("p1", f.original, deliveryFingerprint("hello")).received).toBe(false);
  expect(restarted.accept("p1", { ...f.original, id: randomUUID() }, "next", "next").received).toBe(false);
});
it("recovers an unpublished accepted run even after a different turn advances history", async () => {
  const f = fixture();
  const store = f.store();
  vi.spyOn(ConversationJournal.prototype, "append").mockImplementationOnce(() => {
    throw new Error("append failed");
  });
  const receipts = f.create(store);
  expect(receipts.accept("p1", f.original, "lost event", "lost event").deliveryStage).toBe("uncertain");
  // Another accepted turn publishes cursor 1; the original metadata also names
  // cursor 1. Recovery must use retained history bounds, not just last cursor.
  receipts.accept("p2", { id: randomUUID(), binding: f.original.binding }, "next", "next");
  await store.close();
  const restarted = f.store();
  const original = restarted.inboundAcceptance(f.original.id)!;
  const events = new ConversationJournal(join(f.root, "conversations")).read("global-default");
  expect(events.filter((e) => e.type === "turn" && e.runId === original.runId)).toMatchObject([
    { phase: "accepted", deliveryStage: "stored" },
    { phase: "failed", reasonCode: "service_restarted" },
  ]);
  await store.close();
  await restarted.close();
  expect(f.runner).toHaveBeenCalledTimes(1);
});
it("keeps attempted ID tombstones when conversation acceptance proof is removed", async () => {
  const f = fixture();
  const store = f.store();
  const receipts = f.create(store);
  expect(receipts.accept("p1", f.original, "hello", "hello").received).toBe(true);
  await store.close();
  const path = join(f.root, "conversations/global-default/meta.json");
  const meta = JSON.parse(readFileSync(path, "utf8"));
  delete meta.inboundAcceptances;
  writeFileSync(path, JSON.stringify(meta));
  const restarted = f.create(f.store());
  expect(restarted.accept("p1", f.original, "hello", "hello").deliveryStage).toBe("uncertain");
  expect(f.runner).toHaveBeenCalledTimes(1);
});
it("reports known pre-dispatch unavailability but never applies it to an earlier pending attempt", () => {
  const f = fixture();
  const store = f.store();
  const receipts = f.create(store);
  expect(receipts.refuse("p1", f.original, "hello").deliveryStage).toBe("unavailable");
  vi.spyOn(store, "submitInbound").mockImplementationOnce(() => {
    throw new Error("crash");
  });
  receipts.accept("p1", f.original, "hello", "hello");
  expect(receipts.refuse("p1", f.original, "hello").deliveryStage).toBe("uncertain");
});
