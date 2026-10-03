import { describe, expect, it } from "vitest";
import { deliverFleetSeatMessage, fleetSeatMailbox } from "../src/captain/fleet-seat.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

describe("fleet seat mailbox", () => {
  it("a bound mailbox takes the message and confirms it on its next poll", async () => {
    const mailboxes = new Map<string, SeatOutbox>();
    const mailbox = fleetSeatMailbox(mailboxes, "term-potato");
    const parked = mailbox.poll(5_000);
    const sending = deliverFleetSeatMessage(mailboxes, "term-potato", "Please finish the tests", {
      conversationId: "conv-potato",
      source: "operator",
    });
    const [event] = await parked;
    expect(event).toMatchObject({
      kind: "message",
      conversationId: "conv-potato",
      source: "operator",
      content: "Please finish the tests",
    });
    // Take is acked on the next poll, not at dequeue.
    void mailbox.poll(0);
    await expect(sending).resolves.toEqual({ outcome: "delivered", deliveryStage: "delivered" });
  });

  it("an unbound mailbox reports undelivered without a terminal fallback", async () => {
    const mailboxes = new Map<string, SeatOutbox>();
    await expect(
      deliverFleetSeatMessage(mailboxes, "term-potato", "hello from the room", {
        conversationId: "conv-room",
        source: "room",
      }),
    ).resolves.toMatchObject({
      outcome: "undelivered",
      detail: expect.stringContaining("no terminal input"),
    });
  });

  it("a taken message with no acknowledgement stays unconfirmed and is never queued twice", async () => {
    const mailbox = new SeatOutbox({ boundGraceMs: 10 });
    const mailboxes = new Map([["term-potato", mailbox]]);
    const poll = mailbox.poll(5_000);
    const sending = deliverFleetSeatMessage(mailboxes, "term-potato", "inspect before retrying", {
      conversationId: "conv-potato",
      source: "captain",
    });
    const [event] = await poll;
    await expect(sending).resolves.toMatchObject({ outcome: "unconfirmed", messageId: event!.id });
    expect(await mailbox.poll(0)).toEqual([]);
  });
});
