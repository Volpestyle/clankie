import { z } from "zod";
const Identity = z.string().min(1).max(512);
export const AgentMessageStageSchema = z.enum(["queued", "delivered", "read", "acted_on", "answered"]);
export const AgentMessageProgressSchema = z.strictObject({
  stage: AgentMessageStageSchema,
  observedAt: z.number().finite().nonnegative().optional(),
  /** Native timestamp, when the adapter actually supplies one. */
  occurredAt: z.string().datetime({ offset: true }).optional(),
  evidence: z.enum([
    "native_queue",
    "native_handoff",
    "native_turn_started",
    "native_turn_completed",
    "native_answer",
  ]),
});
export const AgentMessageReceiptSchema = z.strictObject({
  receiptId: z.string().uuid(),
  agent: Identity,
  revision: z.number().int().positive(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  delivery: z.enum(["pending", "queued", "delivered", "uncertain", "refused", "unavailable"]),
  /** Only facts observed for this exact input; missing stages remain unknown. */
  progress: z.array(AgentMessageProgressSchema).max(5),
});
export type AgentMessageReceipt = z.infer<typeof AgentMessageReceiptSchema>;
export const AgentMessageReceiptLookupSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("found"), receipt: AgentMessageReceiptSchema }),
  z.strictObject({ outcome: z.enum(["unknown", "expired", "unavailable"]) }),
]);
export type AgentMessageReceiptLookup = z.infer<typeof AgentMessageReceiptLookupSchema>;

export const AgentMessageReceiptReadSchema = z.strictObject({ receiptId: z.string().uuid() });

export const AgentMessageRefusalCodeSchema = z.enum([
  "agent_message_forbidden",
  "agent_message_unavailable",
  "agent_message_recipient_unavailable",
  "agent_message_request_conflict",
  "agent_message_mode_unsupported",
]);
