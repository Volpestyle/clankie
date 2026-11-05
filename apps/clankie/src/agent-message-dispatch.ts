import type { FleetSeatDelivery } from "./captain/fleet-seat.ts";
import type { AgentMessageBinding } from "./agent-message-receipts.ts";

/** Host-only capture for the original native send. It is never decoded from request JSON. */
export interface AgentMessageDispatch {
  readonly receiptId: string;
  readonly binding: AgentMessageBinding;
  readonly authorize: () => Promise<void>;
  readonly current: () => boolean;
  readonly delivered: (result: FleetSeatDelivery) => void;
}
