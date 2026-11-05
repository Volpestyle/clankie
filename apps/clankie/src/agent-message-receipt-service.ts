import { AgentMessageReceiptReadSchema, type AgentMessageReceiptLookup } from "@clankie/protocol";
import { AgentMessageReceipts } from "./agent-message-receipts.ts";

/** Supplied by the authenticated host boundary, not fields from an app's request. */
export interface AgentMessageReceiptAuthority {
  readonly deviceId: string;
  /** Trusted digest of the original signed session, stable over host restart. */
  readonly sessionId?: string;
  /** Current registration/authorization version, changed by revocation or downgrade. */
  readonly authorizationRevision: string;
  readonly ownerInspection?: true;
}

/** Read-only: no session inspection, native wake, delivery acknowledgment or replay. */
export async function lookupAgentMessageReceipt(
  receipts: AgentMessageReceipts,
  request: unknown,
  authorize: () => Promise<AgentMessageReceiptAuthority | undefined>,
): Promise<AgentMessageReceiptLookup> {
  const { receiptId } = AgentMessageReceiptReadSchema.parse(request);
  const admitted = await authorize();
  if (admitted === undefined) return { outcome: "unknown" };
  // Capture values, not a mutable registration object that the second read may update.
  const { deviceId, sessionId, authorizationRevision, ownerInspection } = admitted;
  let result: AgentMessageReceiptLookup;
  try {
    result =
      ownerInspection === true
        ? receipts.inspectAsOwner(receiptId)
        : receipts.lookup(receiptId, deviceId, sessionId);
  } catch {
    // A broken journal never authorizes a resend or exposes a different sender's record.
    result = { outcome: "unavailable" };
  }
  const current = await authorize();
  if (
    current === undefined ||
    current.deviceId !== deviceId ||
    current.sessionId !== sessionId ||
    current.authorizationRevision !== authorizationRevision ||
    current.ownerInspection !== ownerInspection
  )
    return { outcome: "unknown" };
  return result;
}
