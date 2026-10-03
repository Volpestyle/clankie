import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryFence } from "../src/captain/delivery-fence.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

const dirs: string[] = [];
function path() {
  const dir = mkdtempSync(join(tmpdir(), "delivery-fence-"));
  dirs.push(dir);
  return join(dir, "receipts.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const message = {
  kind: "message" as const,
  conversationId: "conv",
  source: "operator",
  content: "one message",
  wantsReply: false,
};

describe("unresolved delivery receipts", () => {
  it("survives restart, blocks explicit retry, and only reconciles the original receipt", () => {
    const file = path();
    const first = new DeliveryFence(file);
    const receipt = first.begin("seat", { fingerprint: "body" });
    const restarted = new DeliveryFence(file);
    expect(() => restarted.begin("seat", { fingerprint: "replacement" })).toThrow(/uncertain/u);
    expect(restarted.reconcile("seat", "different-id")).toBe(false);
    expect(restarted.reconcile("seat", receipt.messageId)).toBe(true);
    expect(new DeliveryFence(file).pending("seat")).toBeUndefined();
  });
  it("fails closed on malformed persistent receipts", () => {
    const file = path();
    writeFileSync(file, "broken");
    const fence = new DeliveryFence(file);
    expect(fence.pending("any-seat")).toBeDefined();
    expect(() => fence.begin("any-seat", { fingerprint: "body" })).toThrow(/uncertain/u);
    expect(fence.reconcile("any-seat", "unreadable-receipts")).toBe(false);
  });
  it("does not redispatch an uncertain mailbox event after restart or clear it on a new poll", async () => {
    const file = path();
    const first = new SeatOutbox({ uncertaintyPath: file, boundGraceMs: 10 });
    const poll = first.poll(1000);
    const sent = first.deliver(message);
    const [event] = await poll;
    await expect(sent).resolves.toMatchObject({ outcome: "unconfirmed", deliveryStage: "uncertain" });
    first.close();
    const restarted = new SeatOutbox({ uncertaintyPath: file });
    const newPoll = restarted.poll(1000);
    await expect(restarted.deliver(message)).resolves.toMatchObject({
      outcome: "unconfirmed",
      messageId: event?.id,
    });
    expect(restarted.acknowledge("wrong-id")).toBe(false);
    expect(restarted.acknowledge(event!.id)).toBe(true);
    const next = restarted.deliver({ ...message, content: "after receipt" });
    const [nextEvent] = await newPoll;
    expect(nextEvent?.content).toBe("after receipt");
    expect(restarted.acknowledge(nextEvent!.id)).toBe(true);
    await expect(next).resolves.toMatchObject({ deliveryStage: "delivered" });
    restarted.close();
  });
});
