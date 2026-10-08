import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
/** Structural native Pi seam; the captain SDK is not imported by the consumer. */
export function createPiWorkerFleet(
  pi: unknown,
  options?: {
    readonly transport?: Transport;
    readonly beforeCall?: () => Promise<void>;
  },
): { close(): Promise<void> };
