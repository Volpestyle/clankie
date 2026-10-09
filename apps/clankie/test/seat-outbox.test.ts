import { describe, expect, it } from "vitest";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function wake(outbox: SeatOutbox, signal?: AbortSignal, content = "wake up") {
  return outbox.deliver({
    kind: "wake",
    conversationId: "global-default",
    source: "service",
    content,
    wantsReply: false,
    ...(signal === undefined ? {} : { signal }),
  });
}

function message(outbox: SeatOutbox, content: string) {
  return outbox.deliver({
    kind: "message",
    conversationId: "conv-dm",
    source: "operator",
    content,
    wantsReply: false,
  });
}

function peerMessage(outbox: SeatOutbox, content: string, recipientBinding?: string) {
  return outbox.deliver({
    kind: "message",
    conversationId: "global-default",
    source: "peer",
    content,
    wantsReply: false,
    ...(recipientBinding === undefined ? {} : { recipientBinding }),
  });
}

it("retains an exact peer channel acknowledgement for read-only reconciliation after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "peer-outbox-"));
  const uncertaintyPath = join(root, "receipts.json");
  const outbox = new SeatOutbox({ uncertaintyPath });
  try {
    const recipientBinding = "a".repeat(64);
    const poll = outbox.poll(5_000, undefined, recipientBinding);
    const sending = outbox.deliver({
      kind: "message",
      conversationId: "global-default",
      source: "peer",
      recipientBinding,
      content: "Peer message original-id from seat one. Agent output. hello",
      wantsReply: false,
    });
    const [event] = await poll;
    expect(event?.source).toBe("peer");
    expect(outbox.receipt(event!.content)).toBeUndefined();
    expect(outbox.acknowledge(event!.id, recipientBinding)).toBe(true);
    expect(await sending).toMatchObject({ deliveryStage: "delivered" });
    outbox.close();
    const restarted = new SeatOutbox({ uncertaintyPath });
    expect(restarted.receipt(event!.content)).toMatchObject({ outcome: "delivered" });
    expect(restarted.receipt("different original-id or content")).toBeUndefined();
    expect(restarted.acknowledge("invented")).toBe(false);
    expect(await restarted.poll(0)).toEqual([]);
    restarted.close();
  } finally {
    outbox.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([undefined, "replacement-native-binding"])(
  "refuses a queued peer message when a later poll uses binding %s",
  async (binding) => {
    const originalBinding = "original-native-binding";
    const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
    try {
      await outbox.poll(1, undefined, originalBinding);
      const sending = peerMessage(outbox, "Peer message original UUID. Agent output.", originalBinding);
      expect(await outbox.poll(0, undefined, binding)).toEqual([]);
      expect(await sending).toMatchObject({ outcome: "unbound", deliveryStage: "unavailable" });
      expect(outbox.uncertain()).toBe(false);
      expect(outbox.receipt("Peer message original UUID. Agent output.")).toBeUndefined();
      const replacementBinding = "replacement-native-binding";
      const parked = outbox.poll(5_000, undefined, replacementBinding);
      const next = peerMessage(outbox, "A new message for this native recipient", replacementBinding);
      expect((await parked).map((event) => event.content)).toEqual([
        "A new message for this native recipient",
      ]);
      await outbox.poll(0, undefined, replacementBinding);
      expect(await next).toMatchObject({ outcome: "delivered" });
    } finally {
      outbox.close();
    }
  },
);

it("refuses a peer item with no recipient binding even when a native poller is parked", async () => {
  const outbox = new SeatOutbox();
  try {
    const parked = outbox.poll(5_000, undefined, "current-native-binding");
    const sending = peerMessage(outbox, "Unbound peer context");
    expect(await parked).toEqual([]);
    expect(await sending).toMatchObject({ outcome: "unbound", deliveryStage: "unavailable" });
    expect(outbox.uncertain()).toBe(false);
  } finally {
    outbox.close();
  }
});

it("a replacement native session cannot implicitly acknowledge the prior recipient's peer event", async () => {
  const outbox = new SeatOutbox({ boundGraceMs: 30 });
  const content = "Peer message original UUID. Agent output.";
  try {
    const parked = outbox.poll(5_000, undefined, "original-native-binding");
    const sending = peerMessage(outbox, content, "original-native-binding");
    expect((await parked).map((event) => event.content)).toEqual([content]);
    expect(await outbox.poll(0, undefined, "replacement-native-binding")).toEqual([]);
    expect(outbox.receipt(content)).toBeUndefined();
    expect(await sending).toMatchObject({ outcome: "unconfirmed", deliveryStage: "uncertain" });
    expect(outbox.uncertain()).toBe(true);
    expect(await outbox.poll(0, undefined, "replacement-native-binding")).toEqual([]);
    expect(outbox.receipt(content)).toBeUndefined();
    expect(await peerMessage(outbox, "A different original", "replacement-native-binding")).toMatchObject({
      outcome: "unbound",
      deliveryStage: "unavailable",
    });
    expect(outbox.uncertain()).toBe(true);
  } finally {
    outbox.close();
  }
});

it("only a matching native poll can implicitly acknowledge an in-flight peer event", async () => {
  const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
  try {
    const parked = outbox.poll(5_000, undefined, "original-native-binding");
    const sending = peerMessage(outbox, "Original peer event", "original-native-binding");
    await parked;
    let result: unknown;
    void sending.then((value) => {
      result = value;
    });
    await outbox.poll(0, undefined, "replacement-native-binding");
    expect(result).toBeUndefined();
    await outbox.poll(0, undefined, "original-native-binding");
    expect(await sending).toMatchObject({ outcome: "delivered", deliveryStage: "delivered" });
  } finally {
    outbox.close();
  }
});

describe("seat outbox", () => {
  it("is unbound until a poller parks, then hands queued turns to the poller", async () => {
    let now = 1_000;
    const outbox = new SeatOutbox({ boundGraceMs: 100, now: () => now });
    expect(outbox.bound()).toBe(false);
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound", deliveryStage: "unavailable" });

    // wait=0 empty never parked, so it must not bind (F5).
    expect(await outbox.poll(0)).toEqual([]);
    expect(outbox.bound()).toBe(false);

    const parked = outbox.poll(5_000);
    expect(outbox.bound()).toBe(true);
    const delivery = wake(outbox);
    const page = await parked;
    expect(page.map((event) => [event.kind, event.conversationId, event.content])).toEqual([
      ["wake", "global-default", "wake up"],
    ]);
    // Delivered means the bridge came back for more, not that take() ran.
    expect(await outbox.poll(0)).toEqual([]);
    await expect(delivery).resolves.toEqual({
      outcome: "delivered",
      deliveryStage: "delivered",
      messageId: page[0]!.id,
    });

    now += 101;
    expect(outbox.bound()).toBe(false);
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound", deliveryStage: "unavailable" });
  });

  it("holds an escalation open for the seat's reply, and lets a stale reply fall through", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
    const parked = outbox.poll(5_000);
    const delivery = outbox.deliver({
      kind: "escalation",
      conversationId: "global-default",
      source: "clankie-app",
      content: "can you check the build?",
      wantsReply: true,
    });
    const [event] = await parked;
    expect(event?.kind).toBe("escalation");
    expect(outbox.reply("seat-nope", "late")).toBe(false);
    expect(outbox.reply(event!.id, "green, three minutes ago")).toBe(true);
    await expect(delivery).resolves.toEqual({
      deliveryStage: "responded",
      outcome: "replied",
      text: "green, three minutes ago",
    });
    expect(outbox.reply(event!.id, "again")).toBe(false);
  });

  it("settles an escalation as delivered when the reply window lapses", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000, replyTimeoutMs: 5 });
    const parked = outbox.poll(5_000);
    const delivery = outbox.deliver({
      kind: "escalation",
      conversationId: "global-default",
      source: "clankie-app",
      content: "hello?",
      wantsReply: true,
    });
    await parked;
    // Reply window starts on the ack poll, on top of the take/ack grace.
    await outbox.poll(0);
    await expect(delivery).resolves.toEqual({ outcome: "delivered", deliveryStage: "delivered" });
  });

  it("returns a turn to pi when the bridge dies before taking it, and honours the operator's cancel", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 40 });
    expect(await outbox.poll(5)).toEqual([]);
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound", deliveryStage: "unavailable" });

    const live = new SeatOutbox({ boundGraceMs: 1_000 });
    const parked = live.poll(5_000);
    const controller = new AbortController();
    const delivery = wake(live, controller.signal);
    await parked;
    controller.abort();
    await expect(delivery).resolves.toMatchObject({ outcome: "unconfirmed" });
    expect(await live.poll(0)).toEqual([]);
  });

  it("aborts what is queued and releases a parked poll on close", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
    const taken = outbox.poll(5_000);
    const delivery = wake(outbox);
    await taken;
    outbox.close();
    await expect(delivery).rejects.toThrow("may still be working");

    const parkedOutbox = new SeatOutbox({ boundGraceMs: 1_000 });
    const parked = parkedOutbox.poll(5_000);
    parkedOutbox.close();
    expect(await parked).toEqual([]);
  });

  it("settles unbound within the remaining grace when the bridge dies between polls", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 40 });
    expect(await outbox.poll(5)).toEqual([]);
    expect(outbox.bound()).toBe(true);
    const started = Date.now();
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound", deliveryStage: "unavailable" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("marks a taken event delivered only after the next poll, and unconfirmed if none arrives", async () => {
    const acked = new SeatOutbox({ boundGraceMs: 1_000 });
    const parked = acked.poll(5_000);
    const delivery = wake(acked);
    const page = await parked;
    expect(page.map((event) => event.content)).toEqual(["wake up"]);
    let resolved: unknown;
    void delivery.then((outcome) => {
      resolved = outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(resolved).toBeUndefined();
    expect(await acked.poll(0)).toEqual([]);
    await expect(delivery).resolves.toEqual({
      outcome: "delivered",
      deliveryStage: "delivered",
      messageId: page[0]!.id,
    });

    const dropped = new SeatOutbox({ boundGraceMs: 30 });
    const first = dropped.poll(5_000);
    const lost = wake(dropped, undefined, "do not duplicate");
    expect((await first).map((event) => event.content)).toEqual(["do not duplicate"]);
    await expect(lost).resolves.toMatchObject({ outcome: "unconfirmed", messageId: expect.any(String) });
    expect(await dropped.poll(0)).toEqual([]);
  });

  it("keeps one live waiter: a newer poll supersedes the older with an empty page", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
    const older = outbox.poll(5_000);
    const newer = outbox.poll(5_000);
    expect(await older).toEqual([]);
    const delivery = wake(outbox);
    const page = await newer;
    expect(page.map((event) => event.content)).toEqual(["wake up"]);
    expect(await outbox.poll(0)).toEqual([]);
    await expect(delivery).resolves.toEqual({
      outcome: "delivered",
      deliveryStage: "delivered",
      messageId: page[0]!.id,
    });
  });

  it("delivers two successive turns in order to one live bridge that re-polls", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
    const firstPoll = outbox.poll(5_000);
    const first = message(outbox, "dm-1");
    const firstPage = await firstPoll;
    expect(firstPage.map((event) => event.content)).toEqual(["dm-1"]);
    const secondPoll = outbox.poll(5_000);
    const second = message(outbox, "dm-2");
    const secondPage = await secondPoll;
    expect(secondPage.map((event) => event.content)).toEqual(["dm-2"]);
    expect(await outbox.poll(0)).toEqual([]);
    await expect(first).resolves.toEqual({
      outcome: "delivered",
      deliveryStage: "delivered",
      messageId: firstPage[0]!.id,
    });
    await expect(second).resolves.toEqual({
      outcome: "delivered",
      deliveryStage: "delivered",
      messageId: secondPage[0]!.id,
    });
    expect(firstPage[0]!.id).not.toBe(secondPage[0]!.id);
  });
});
