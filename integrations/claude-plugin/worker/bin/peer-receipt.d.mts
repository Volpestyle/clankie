interface PeerReceipt {
  schemaVersion: 1;
  deliveryStage:
    | "stored"
    | "delivered"
    | "consumed"
    | "uncertain"
    | "recipient_gone"
    | "superseded"
    | "rejected"
    | "unavailable";
  outcome: "delivered" | "unconfirmed" | "undelivered" | "offline";
  deliveryId?: string;
  binding?: string;
  seatId?: string;
  recipientBinding?: string;
  fingerprint?: string;
  detail?: string;
  retryable?: boolean;
  messageId?: string;
  state?: "queued" | "started" | "steered";
  /** A settled original's outcome, returned with the different follow-up sent after it. */
  previous?: Pick<PeerReceipt, "deliveryStage" | "outcome" | "deliveryId" | "detail">;
}
interface PeerSeat {
  seatId: string;
  paneId: string;
  binding: string;
  harness: string;
  title: string;
}
export function readPeerCatalog(
  value: unknown,
): { schemaVersion: 1; fleet: string; sender: PeerSeat; seats: PeerSeat[] } | undefined;
export function createPeerSender(options: {
  directory: string;
  scope: string;
  discover: () => Promise<Response>;
  request: (suffix: string, init?: { method: string; body: string }) => Promise<Response>;
}): ((seat: string, text: string) => Promise<PeerReceipt>) & {
  reconcilePending(): Promise<PeerReceipt | undefined>;
};
