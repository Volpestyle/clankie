import { describe, expect, it } from "vitest";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

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

describe("seat outbox", () => {
  it("is unbound until a poller parks, then hands queued turns to the poller", async () => {
    let now = 1_000;
    const outbox = new SeatOutbox({ boundGraceMs: 100, now: () => now });
    expect(outbox.bound()).toBe(false);
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound" });

    // wait=0 empty never parked, so it must not bind (F5).
    expect(await outbox.poll(0)).toEqual([]);
    expect(outbox.bound()).toBe(false);

    const parked = outbox.poll(5_000);
    expect(outbox.bound()).toBe(true);
    const delivery = wake(outbox);
    expect((await parked).map((event) => [event.kind, event.conversationId, event.content])).toEqual([
      ["wake", "global-default", "wake up"],
    ]);
    // Delivered means the bridge came back for more, not that take() ran.
    expect(await outbox.poll(0)).toEqual([]);
    await expect(delivery).resolves.toEqual({ outcome: "delivered" });

    now += 101;
    expect(outbox.bound()).toBe(false);
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound" });
  });

  it("wakes a parked poll the moment a turn arrives", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
    const parked = outbox.poll(5_000);
    const delivery = wake(outbox);
    expect((await parked).map((event) => event.content)).toEqual(["wake up"]);
    await outbox.poll(0);
    await expect(delivery).resolves.toEqual({ outcome: "delivered" });
  });

  it("holds an escalation open for the seat's reply, and lets a stale reply fall through", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
    const parked = outbox.poll(5_000);
    const delivery = outbox.deliver({
      kind: "escalation",
      conversationId: "global-default",
      source: "clankie-menu-bar-voice",
      content: "can you check the build?",
      wantsReply: true,
    });
    const [event] = await parked;
    expect(event?.kind).toBe("escalation");
    expect(outbox.reply("seat-nope", "late")).toBe(false);
    expect(outbox.reply(event!.id, "green, three minutes ago")).toBe(true);
    await expect(delivery).resolves.toEqual({ outcome: "replied", text: "green, three minutes ago" });
    expect(outbox.reply(event!.id, "again")).toBe(false);
  });

  it("settles an escalation as delivered when the reply window lapses", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000, replyTimeoutMs: 5 });
    const parked = outbox.poll(5_000);
    const delivery = outbox.deliver({
      kind: "escalation",
      conversationId: "global-default",
      source: "clankie-menu-bar-voice",
      content: "hello?",
      wantsReply: true,
    });
    await parked;
    // Reply window starts on the ack poll, on top of the take/ack grace.
    await outbox.poll(0);
    await expect(delivery).resolves.toEqual({ outcome: "delivered" });
  });

  it("returns a turn to pi when the bridge dies before taking it, and honours the operator's cancel", async () => {
    const outbox = new SeatOutbox({ boundTtlMs: 40 });
    expect(await outbox.poll(5)).toEqual([]);
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound" });

    const live = new SeatOutbox({ boundGraceMs: 1_000 });
    const parked = live.poll(5_000);
    const controller = new AbortController();
    const delivery = wake(live, controller.signal);
    await parked;
    controller.abort();
    await expect(delivery).resolves.toEqual({ outcome: "aborted" });
    expect(await live.poll(0)).toEqual([]);
  });

  it("aborts what is queued and releases a parked poll on close", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
    const taken = outbox.poll(5_000);
    const delivery = wake(outbox);
    await taken;
    outbox.close();
    await expect(delivery).resolves.toEqual({ outcome: "aborted" });

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
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("marks a taken event delivered only after the next poll, and unbound if none arrives", async () => {
    const acked = new SeatOutbox({ boundGraceMs: 1_000 });
    const parked = acked.poll(5_000);
    const delivery = wake(acked);
    expect((await parked).map((event) => event.content)).toEqual(["wake up"]);
    let resolved: unknown;
    void delivery.then((outcome) => {
      resolved = outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(resolved).toBeUndefined();
    expect(await acked.poll(0)).toEqual([]);
    await expect(delivery).resolves.toEqual({ outcome: "delivered" });

    const dropped = new SeatOutbox({ boundGraceMs: 30 });
    const first = dropped.poll(5_000);
    const lost = wake(dropped, undefined, "do not duplicate");
    expect((await first).map((event) => event.content)).toEqual(["do not duplicate"]);
    await expect(lost).resolves.toEqual({ outcome: "unbound" });
    expect(await dropped.poll(0)).toEqual([]);
  });

  it("keeps one live waiter: a newer poll supersedes the older with an empty page", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
    const older = outbox.poll(5_000);
    const newer = outbox.poll(5_000);
    expect(await older).toEqual([]);
    const delivery = wake(outbox);
    expect((await newer).map((event) => event.content)).toEqual(["wake up"]);
    expect(await outbox.poll(0)).toEqual([]);
    await expect(delivery).resolves.toEqual({ outcome: "delivered" });
  });

  it("delivers two successive turns in order to one live bridge that re-polls", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
    const firstPoll = outbox.poll(5_000);
    const first = message(outbox, "dm-1");
    expect((await firstPoll).map((event) => event.content)).toEqual(["dm-1"]);
    const secondPoll = outbox.poll(5_000);
    const second = message(outbox, "dm-2");
    expect((await secondPoll).map((event) => event.content)).toEqual(["dm-2"]);
    expect(await outbox.poll(0)).toEqual([]);
    await expect(first).resolves.toEqual({ outcome: "delivered" });
    await expect(second).resolves.toEqual({ outcome: "delivered" });
  });

  it("a wait=0 empty poll does not bind", async () => {
    const outbox = new SeatOutbox({ boundGraceMs: 1_000 });
    expect(await outbox.poll(0)).toEqual([]);
    expect(outbox.bound()).toBe(false);
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound" });
  });
});
