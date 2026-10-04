import { CAPTAIN_SILENT_REPLY_SENTINEL, CaptainChannelTurnResultSchema } from "@clankie/protocol";
import { expect, it } from "vitest";
import { roomSeatTurnResult } from "../src/captain/room-conversations.ts";
import type { SeatDelivery } from "../src/captain/seat-outbox.ts";

it("only definite pre-acceptance refusal hands a room request back to the service", () => {
  expect(roomSeatTurnResult({ outcome: "unbound", deliveryStage: "unavailable" }, "room", "turn")).toBe(
    undefined,
  );
  const deliveries: SeatDelivery[] = [
    { outcome: "delivered", deliveryStage: "delivered" },
    { outcome: "aborted", deliveryStage: "expired" },
    {
      outcome: "unconfirmed",
      deliveryStage: "uncertain",
      messageId: "exact-event",
      detail: "The bridge may have received the request",
    },
    { outcome: "replied", text: "   ", deliveryStage: "responded" },
  ];
  for (const delivery of deliveries) {
    const result = roomSeatTurnResult(delivery, "room", "turn");
    CaptainChannelTurnResultSchema.parse(result);
    expect(result).toMatchObject({ state: "failed", deliveryStage: delivery.deliveryStage });
  }
});

it("native room replies preserve whole-message silence and bound the transport response", () => {
  const result = (text: string) => roomSeatTurnResult({ outcome: "replied", text }, "room", "turn");
  expect(result(`  ${CAPTAIN_SILENT_REPLY_SENTINEL}\n`)).toMatchObject({ state: "silent" });
  expect(result(`They said ${CAPTAIN_SILENT_REPLY_SENTINEL}.`)).toMatchObject({
    state: "settled",
    response: `They said ${CAPTAIN_SILENT_REPLY_SENTINEL}.`,
  });
  const bounded = result("a".repeat(20_000));
  CaptainChannelTurnResultSchema.parse(bounded);
  expect(bounded?.state === "settled" && bounded.response.length).toBe(16_384);
});
