interface InboundReceipt {
  received: boolean;
  deliveryStage: "stored" | "uncertain" | "rejected" | "unavailable";
  detail?: string;
  deliveryId?: string;
  binding?: string;
  fingerprint?: string;
}
export function createInboundSender(options: {
  directory: string;
  scope: string;
  request: (suffix: string, init?: { method: string; body: string; redirect?: "error" }) => Promise<Response>;
}): (text: string) => Promise<InboundReceipt>;
