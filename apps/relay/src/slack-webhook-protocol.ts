import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const SLACK_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
/** Slack's own replay guidance: reject anything older than five minutes. */
export const SLACK_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1_000;
/** Slack retries any event it does not see acknowledged within three seconds. */
export const SLACK_WEBHOOK_ACK_DEADLINE_MS = 3_000;
export const SLACK_WEBHOOK_RESPONSE_DEADLINE_MS = 2_500;

const boundedId = z.string().min(1).max(64);
const boundedText = z.string().max(SLACK_WEBHOOK_MAX_BODY_BYTES);

/**
 * Only the addressed shapes the bridge subscribes to (ADR 0080). `message`
 * events arrive for every reply in a subscribed conversation, so the bridge —
 * not this schema — decides which ones were actually addressed to him.
 */
const SlackInnerEventSchema = z
  .object({
    type: z.enum(["app_mention", "message"]),
    channel: boundedId,
    user: boundedId.optional(),
    bot_id: boundedId.optional(),
    ts: boundedId,
    thread_ts: boundedId.optional(),
    channel_type: z.string().max(32).optional(),
    subtype: z.string().max(64).optional(),
    text: boundedText.optional(),
  })
  .passthrough();

export const SlackEventCallbackSchema = z
  .object({
    type: z.literal("event_callback"),
    token: z.string().max(128).optional(),
    team_id: boundedId,
    api_app_id: boundedId.optional(),
    event_id: boundedId,
    event_time: z.number().int().nonnegative(),
    authorizations: z
      .array(z.object({ user_id: boundedId.optional() }).passthrough())
      .max(32)
      .optional(),
    event: SlackInnerEventSchema,
  })
  .passthrough();

export type SlackEventCallback = z.infer<typeof SlackEventCallbackSchema>;

/** Slack's one-time endpoint proof. It carries no event and starts no turn. */
export const SlackUrlVerificationSchema = z
  .object({
    type: z.literal("url_verification"),
    challenge: z.string().min(1).max(512),
  })
  .passthrough();

export type SlackUrlVerification = z.infer<typeof SlackUrlVerificationSchema>;

export const SlackWebhookPayloadSchema = z.union([SlackUrlVerificationSchema, SlackEventCallbackSchema]);

export type SlackWebhookPayload = z.infer<typeof SlackWebhookPayloadSchema>;

export const VerifiedSlackEventSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("slack.event"),
    deliveryId: z.uuid(),
    correlationId: z.string().min(1).max(160),
    receivedAtMs: z.number().int().nonnegative(),
    payload: SlackEventCallbackSchema,
  })
  .strict();

export type VerifiedSlackEvent = z.infer<typeof VerifiedSlackEventSchema>;

export function slackWebhookCorrelationId(eventId: string): string {
  return `slack-event:${eventId}`;
}

/**
 * Slack's v0 signature covers a versioned basestring, not the body alone —
 * `v0:<timestamp>:<raw body>` — which is what binds a signature to the moment
 * it was issued and makes the replay window meaningful. Verifying the body by
 * itself would accept a valid old signature forever.
 */
export function slackSignatureBasestring(timestamp: string, rawBody: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`v0:${timestamp}:`, "utf8"), Buffer.from(rawBody)]);
}

export function verifySlackWebhookSignature(
  rawBody: Uint8Array,
  timestamp: string,
  signature: string,
  signingSecret: string | Uint8Array,
): boolean {
  if (!/^v0=[a-fA-F0-9]{64}$/u.test(signature)) return false;
  const supplied = Buffer.from(signature.slice("v0=".length), "hex");
  const computed = createHmac("sha256", signingSecret)
    .update(slackSignatureBasestring(timestamp, rawBody))
    .digest();
  return supplied.byteLength === computed.byteLength && timingSafeEqual(supplied, computed);
}

/** A timestamp outside the window is refused before any signature work. */
export function slackTimestampWithinWindow(
  timestamp: string,
  nowMs: number,
  windowMs = SLACK_WEBHOOK_REPLAY_WINDOW_MS,
): boolean {
  if (!/^\d{1,11}$/u.test(timestamp)) return false;
  const sentMs = Number.parseInt(timestamp, 10) * 1_000;
  if (!Number.isFinite(sentMs)) return false;
  return Math.abs(nowMs - sentMs) <= windowMs;
}

export type SlackWebhookEvidenceOutcome =
  | "accepted"
  | "challenge"
  | "duplicate"
  | "ignored"
  | "rejected"
  | "verified";

export interface SlackWebhookEvidence {
  readonly service: "slack-webhook-ingress";
  readonly outcome: SlackWebhookEvidenceOutcome;
  readonly timestampMs: number;
  readonly deliveryId?: string;
  readonly correlationId?: string;
  readonly reason?: string;
}

export type SlackWebhookEvidenceSink = (evidence: SlackWebhookEvidence) => void;
