import { describe, expect, it } from "vitest";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

function wake(outbox: SeatOutbox, signal?: AbortSignal) {
  return outbox.deliver({
    kind: "wake",
    conversationId: "global-default",
    source: "service",
    content: "wake up",
    wantsReply: false,
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("seat outbox", () => {
  it("is unbound until something polls, then hands queued turns to the poller", async () => {
    let now = 1_000;
    const outbox = new SeatOutbox({ boundTtlMs: 100, now: () => now });
    expect(outbox.bound()).toBe(false);
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound" });

    expect(await outbox.poll(0)).toEqual([]);
    expect(outbox.bound()).toBe(true);
    const delivery = wake(outbox);
    const taken = await outbox.poll(1_000);
    expect(taken.map((event) => [event.kind, event.conversationId, event.content])).toEqual([
      ["wake", "global-default", "wake up"],
    ]);
    await expect(delivery).resolves.toEqual({ outcome: "delivered" });

    now += 101;
    expect(outbox.bound()).toBe(false);
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound" });
  });

  it("wakes a parked poll the moment a turn arrives", async () => {
    const outbox = new SeatOutbox({ boundTtlMs: 1_000 });
    const parked = outbox.poll(5_000);
    const delivery = wake(outbox);
    expect((await parked).map((event) => event.content)).toEqual(["wake up"]);
    await expect(delivery).resolves.toEqual({ outcome: "delivered" });
  });

  it("holds an escalation open for the seat's reply, and lets a stale reply fall through", async () => {
    const outbox = new SeatOutbox({ boundTtlMs: 1_000 });
    await outbox.poll(0);
    const delivery = outbox.deliver({
      kind: "escalation",
      conversationId: "global-default",
      source: "clankie-menu-bar-voice",
      content: "can you check the build?",
      wantsReply: true,
    });
    const [event] = await outbox.poll(1_000);
    expect(event?.kind).toBe("escalation");
    expect(outbox.reply("seat-nope", "late")).toBe(false);
    expect(outbox.reply(event!.id, "green, three minutes ago")).toBe(true);
    await expect(delivery).resolves.toEqual({ outcome: "replied", text: "green, three minutes ago" });
    expect(outbox.reply(event!.id, "again")).toBe(false);
  });

  it("settles an escalation as delivered when the reply window lapses", async () => {
    const outbox = new SeatOutbox({ boundTtlMs: 1_000, replyTimeoutMs: 5 });
    await outbox.poll(0);
    const delivery = outbox.deliver({
      kind: "escalation",
      conversationId: "global-default",
      source: "clankie-menu-bar-voice",
      content: "hello?",
      wantsReply: true,
    });
    await outbox.poll(1_000);
    await expect(delivery).resolves.toEqual({ outcome: "delivered" });
  });

  it("returns a turn to pi when the bridge dies before taking it, and honours the operator's cancel", async () => {
    const outbox = new SeatOutbox({ boundTtlMs: 5 });
    await outbox.poll(0);
    await expect(wake(outbox)).resolves.toEqual({ outcome: "unbound" });

    const live = new SeatOutbox({ boundTtlMs: 1_000 });
    await live.poll(0);
    const controller = new AbortController();
    const delivery = wake(live, controller.signal);
    controller.abort();
    await expect(delivery).resolves.toEqual({ outcome: "aborted" });
    expect(await live.poll(0)).toEqual([]);
  });

  it("aborts what is queued and releases a parked poll on close", async () => {
    const outbox = new SeatOutbox({ boundTtlMs: 1_000 });
    await outbox.poll(0);
    const delivery = wake(outbox);
    outbox.close();
    await expect(delivery).resolves.toEqual({ outcome: "aborted" });

    const parkedOutbox = new SeatOutbox({ boundTtlMs: 1_000 });
    const parked = parkedOutbox.poll(5_000);
    parkedOutbox.close();
    expect(await parked).toEqual([]);
  });
});
