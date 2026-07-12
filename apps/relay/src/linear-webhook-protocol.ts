import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const LINEAR_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const LINEAR_WEBHOOK_REPLAY_WINDOW_MS = 60_000;
export const LINEAR_WEBHOOK_HTTP_DEADLINE_MS = 5_000;
export const LINEAR_WEBHOOK_RESPONSE_DEADLINE_MS = 4_500;
export const LINEAR_AGENT_ACTIVITY_ACK_TARGET_MS = 10_000;

const boundedId = z.string().min(1).max(128);
const boundedText = z.string().max(LINEAR_WEBHOOK_MAX_BODY_BYTES);
const base64Length = Math.ceil(LINEAR_WEBHOOK_MAX_BODY_BYTES / 3) * 4;

const AgentSessionSchema = z
  .object({
    id: boundedId,
    promptContext: boundedText.optional(),
  })
  .passthrough();

const AgentActivitySchema = z
  .object({
    id: boundedId.optional(),
    content: z
      .object({
        type: z.literal("prompt"),
        body: boundedText,
      })
      .passthrough(),
  })
  .passthrough();

const AgentSessionWebhookBase = z.object({
  type: z.literal("AgentSessionEvent"),
  webhookTimestamp: z.number().int().nonnegative(),
  webhookId: boundedId,
  organizationId: boundedId,
  agentSession: AgentSessionSchema,
});

export const LinearAgentSessionWebhookPayloadSchema = z.discriminatedUnion("action", [
  AgentSessionWebhookBase.extend({ action: z.literal("created") }).passthrough(),
  AgentSessionWebhookBase.extend({
    action: z.literal("prompted"),
    agentActivity: AgentActivitySchema,
  }).passthrough(),
]);

export type LinearAgentSessionWebhookPayload = z.infer<typeof LinearAgentSessionWebhookPayloadSchema>;

export const LinearWebhookEnvelopeSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("linear.agent-session-webhook"),
    deliveryId: z.uuid(),
    correlationId: z.string().min(1).max(160),
    eventType: z.literal("AgentSessionEvent"),
    action: z.enum(["created", "prompted"]),
    timestampMs: z.number().int().nonnegative(),
    receivedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
    signature: z.string().regex(/^[a-fA-F0-9]{64}$/u),
    rawBodyBase64: z
      .string()
      .max(base64Length)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  })
  .strict();

export type LinearWebhookEnvelope = z.infer<typeof LinearWebhookEnvelopeSchema>;

export const LinearWebhookLeasedDeliverySchema = z
  .object({
    deliveryId: z.uuid(),
    attempt: z.number().int().positive(),
    envelope: LinearWebhookEnvelopeSchema,
  })
  .strict();

export type LinearWebhookLeasedDelivery = z.infer<typeof LinearWebhookLeasedDeliverySchema>;

export const VerifiedLinearAgentSessionEventSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("linear.agent-session-event"),
    deliveryId: z.uuid(),
    correlationId: z.string().min(1).max(160),
    receivedAtMs: z.number().int().nonnegative(),
    payload: LinearAgentSessionWebhookPayloadSchema,
  })
  .strict();

export type VerifiedLinearAgentSessionEvent = z.infer<typeof VerifiedLinearAgentSessionEventSchema>;

export type LinearWebhookEvidenceOutcome =
  | "accepted"
  | "backpressure"
  | "bridge_connected"
  | "bridge_disconnected"
  | "dead_lettered"
  | "delivered"
  | "duplicate"
  | "expired"
  | "offline"
  | "rejected"
  | "retry_scheduled"
  | "verified";

export interface LinearWebhookEvidence {
  readonly service: "linear-webhook-ingress" | "linear-webhook-local-bridge";
  readonly outcome: LinearWebhookEvidenceOutcome;
  readonly timestampMs: number;
  readonly deliveryId?: string;
  readonly correlationId?: string;
  readonly reason?: string;
  readonly queueDepth?: number;
  readonly attempt?: number;
}

export type LinearWebhookEvidenceSink = (evidence: LinearWebhookEvidence) => void;

export function linearWebhookCorrelationId(deliveryId: string): string {
  return `linear-delivery:${deliveryId}`;
}

export function verifyLinearWebhookSignature(
  rawBody: Uint8Array,
  signature: string,
  signingSecret: string | Uint8Array,
): boolean {
  if (!/^[a-fA-F0-9]{64}$/u.test(signature)) return false;
  const supplied = Buffer.from(signature, "hex");
  const computed = createHmac("sha256", signingSecret).update(rawBody).digest();
  return supplied.byteLength === computed.byteLength && timingSafeEqual(supplied, computed);
}

export function decodeLinearWebhookBody(rawBodyBase64: string): Uint8Array | undefined {
  if (!LinearWebhookEnvelopeSchema.shape.rawBodyBase64.safeParse(rawBodyBase64).success) {
    return undefined;
  }
  const decoded = Buffer.from(rawBodyBase64, "base64");
  if (decoded.byteLength > LINEAR_WEBHOOK_MAX_BODY_BYTES) return undefined;
  if (decoded.toString("base64") !== rawBodyBase64) return undefined;
  return decoded;
}
