import type { OperatorFleetSeat } from "@clankie/protocol";
import type { createConversationWakes } from "./conversation-wakes.ts";
import type { FleetSeatDelivery, FleetSeatMessageContext } from "./fleet-seat.ts";
import type { PeerDeliveryOptions } from "./peer-seat-messages.ts";

/** Shapes the captain hands to the modules split out of it (ADR 0325). */
export type DeliverToSeat = (
  seatId: string,
  message: string,
  context: FleetSeatMessageContext,
  deliveryOptions?: PeerDeliveryOptions,
) => Promise<FleetSeatDelivery>;

export type RefreshFleet = (options?: { force?: boolean }) => Promise<readonly OperatorFleetSeat[]>;

export type WakeConversation = ReturnType<typeof createConversationWakes>["wakeConversation"];
