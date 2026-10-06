interface InboundReceipt {
  received: boolean;
  deliveryStage: "stored" | "uncertain" | "rejected" | "unavailable";
  detail?: string;
  deliveryId?: string;
  binding?: string;
  fingerprint?: string;
}
import type { WorkerReportBridgeStatus } from "@clankie/protocol";
export function createInboundSender(options: {
  onObservation?: (observation: WorkerReportBridgeStatus) => unknown;
  now?: () => number;
  directory: string;
  scope: string;
  request: (suffix: string, init?: { method: string; body: string; redirect?: "error" }) => Promise<Response>;
}): (text: string) => Promise<InboundReceipt>;
