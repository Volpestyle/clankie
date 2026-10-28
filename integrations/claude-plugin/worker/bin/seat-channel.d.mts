export function callNativeReceipt(
  args:
    | { receiptId: string; action: "inspect"; abandonmentId?: string }
    | { receiptId: string; action: "abandon-read"; reason: string },
  options?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch },
): Promise<unknown>;

export function runSeatChannel(options: {
  paneId?: string;
  parentArgv?: string;
  requestTimeoutMs?: number;
  unknownAckTimeoutMs?: number;
}): void;
