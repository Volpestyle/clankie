import { afterEach, expect, it, vi } from "vitest";
import { OperatorSeatEventKindSchema } from "@clankie/protocol";
import { pumpSeatEvents } from "../../tui/src/command/mcp.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

// VUH-2045: the local operator seat went deaf while idle. Every event the seat
// takes starts a turn, and only the seat's own "waiting" sync ends it. A seat
// whose hooks cannot sync never sends one, so a queued fleet review held the
// conversation's runs, and every wake behind it, for 34 minutes. The real
// outbox and the real channel pump the seat bridge runs; no activity sync.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function channel(outbox: SeatOutbox) {
  const notifications: string[] = [];
  const stop = new AbortController();
  const capabilities = {
    schemaVersion: 1 as const,
    eventKinds: [...OperatorSeatEventKindSchema.options],
    ownerOrigin: true,
  };
  const pump = pumpSeatEvents(
    {
      notification: async (event) => {
        notifications.push((event as { params: { content: string } }).params.content);
      },
    },
    { pollEvents: (waitMs, signal) => outbox.poll(waitMs, signal, undefined, capabilities) },
    stop.signal,
    { waitMs: 200, retryMs: 20 },
  );
  cleanup.push(async () => {
    stop.abort();
    outbox.close();
    await pump;
  });
  return notifications;
}

const send = (outbox: SeatOutbox, content: string, delivery?: "queue") =>
  outbox.deliver({
    kind: "watch",
    conversationId: "global-default",
    source: "service",
    content,
    wantsReply: false,
    ...(delivery === undefined ? {} : { delivery }),
  });

it("a queued delivery behind a turn the seat never reports finishing is delivered once the turn goes quiet", async () => {
  const outbox = new SeatOutbox({ turnHoldStaleMs: 400 });
  const notifications = channel(outbox);
  await vi.waitFor(() => expect(outbox.bound()).toBe(true));

  // A worker report starts the seat's turn; its hooks report turns starting but
  // never this one ending.
  expect(outbox.observeTurn("session-a", "responding")).toBe(true);
  expect(await send(outbox, "Worker report: tests passed")).toMatchObject({ outcome: "delivered" });
  const admitted = vi.fn();
  const held = outbox.deliver({
    kind: "watch",
    conversationId: "global-default",
    source: "service",
    content: "Fleet review",
    wantsReply: false,
    delivery: "queue",
    onAdmitted: admitted,
  });
  // While the turn is fresh the review waits its turn instead of interrupting.
  expect(admitted).toHaveBeenCalledWith("queued");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(notifications).toEqual(["Worker report: tests passed"]);

  // Then the quiet turn releases it, while the same bridge keeps polling.
  expect(await held).toMatchObject({ outcome: "delivered" });
  expect(notifications).toEqual(["Worker report: tests passed", "Fleet review"]);
  // Expiry stops blocking delivery only: the turn is never reported idle.
  expect(admitted).toHaveBeenLastCalledWith("steered");
});

it("a seat that never syncs its turns does not hold a queued delivery at all", async () => {
  // The 12:00 wake that ran three hours late (VUH-2045): a seat launched without
  // its session identity reports no turns, so nothing it takes can be ended.
  const outbox = new SeatOutbox({ turnHoldStaleMs: 60_000 });
  const notifications = channel(outbox);
  await vi.waitFor(() => expect(outbox.bound()).toBe(true));
  expect(await send(outbox, "Worker report: tests passed")).toMatchObject({ outcome: "delivered" });
  const admitted = vi.fn();
  expect(
    await outbox.deliver({
      kind: "watch",
      conversationId: "global-default",
      source: "service",
      content: "Fleet review",
      wantsReply: false,
      delivery: "queue",
      onAdmitted: admitted,
    }),
  ).toMatchObject({ outcome: "delivered" });
  expect(notifications).toEqual(["Worker report: tests passed", "Fleet review"]);
  // The taken report's turn is still live: the review steers it, never reports it idle.
  expect(admitted).not.toHaveBeenCalledWith("queued");
  expect(admitted).toHaveBeenLastCalledWith("steered");
});

it("a late waiting from an older session never clears a newer holder's turn", async () => {
  const outbox = new SeatOutbox({ turnHoldStaleMs: 60_000 });
  const notifications = channel(outbox);
  await vi.waitFor(() => expect(outbox.bound()).toBe(true));
  expect(outbox.observeTurn("session-old", "responding")).toBe(true);
  expect(outbox.observeTurn("session-new", "responding")).toBe(true);
  const held = send(outbox, "Held for the newer turn", "queue");
  expect(outbox.observeTurn("session-old", "waiting")).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(notifications).toEqual([]);
  expect(outbox.observeTurn("session-new", "waiting")).toBe(true);
  expect(await held).toMatchObject({ outcome: "delivered" });
});

it("a seat that reports its turn ending still releases a queued delivery at once", async () => {
  const outbox = new SeatOutbox({ turnHoldStaleMs: 60_000 });
  const notifications = channel(outbox);
  await vi.waitFor(() => expect(outbox.bound()).toBe(true));
  expect(outbox.observeTurn("session-a", "responding")).toBe(true);
  const held = send(outbox, "Queued until the turn ends", "queue");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(notifications).toEqual([]);
  expect(outbox.observeTurn("session-a", "waiting")).toBe(true);
  expect(await held).toMatchObject({ outcome: "delivered" });
  expect(notifications).toEqual(["Queued until the turn ends"]);
});
