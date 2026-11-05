import type { FleetSeatDelivery } from "./captain/fleet-seat.ts";
import type { AgentMessageBinding } from "./agent-message-receipts.ts";
import type { SeatEvent } from "@clankie/agent-hosts";

/** A host-captured original control, with no send or retarget capability. */
export interface NativeMessageObservation {
  readonly messageId: string;
  readonly read: (signal: AbortSignal) => Promise<SeatEvent>;
  /** Last awaited recipient read, followed by a synchronous original-recipient/control check. */
  readonly publicationFence: (signal: AbortSignal) => Promise<() => boolean>;
}

/** Host-only capture for the original native send. It is never decoded from request JSON. */
export interface AgentMessageDispatch {
  readonly receiptId: string;
  readonly binding: AgentMessageBinding;
  readonly authorize: () => Promise<void>;
  readonly current: () => boolean;
  readonly delivered: (result: FleetSeatDelivery) => void;
  readonly nativeObservation?: (source: NativeMessageObservation) => void;
}
