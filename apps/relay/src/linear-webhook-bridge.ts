import {
  LINEAR_WEBHOOK_REPLAY_WINDOW_MS,
  LinearAgentSessionWebhookPayloadSchema,
  LinearWebhookLeasedDeliverySchema,
  VerifiedLinearAgentSessionEventSchema,
  decodeLinearWebhookBody,
  type LinearWebhookEvidence,
  type LinearWebhookEvidenceSink,
  type VerifiedLinearAgentSessionEvent,
  verifyLinearWebhookSignature,
} from "./linear-webhook-protocol.ts";
import type { LinearWebhookDeliveryChannel, LinearWebhookOutboundTransport } from "./linear-webhook-queue.ts";

export interface LinearWebhookLocalBridgeOptions {
  readonly signingSecret: string | Uint8Array;
  readonly replayWindowMs?: number;
  readonly clock?: () => number;
  readonly evidence?: LinearWebhookEvidenceSink;
}

export type LinearWebhookBridgeOutcome =
  | "dead_lettered"
  | "delivered"
  | "idle"
  | "rejected"
  | "retry_scheduled";

export type LinearWebhookConsumer = (event: VerifiedLinearAgentSessionEvent) => Promise<void> | void;

const noopEvidence: LinearWebhookEvidenceSink = () => undefined;

/**
 * The local side creates this bridge and dials a hosted transport. It never binds
 * a listener. Every delivery is independently verified because the ingress is not trusted.
 */
export class LinearWebhookLocalBridge {
  private readonly signingSecret: string | Uint8Array;
  private readonly replayWindowMs: number;
  private readonly clock: () => number;
  private readonly evidence: LinearWebhookEvidenceSink;

  public constructor(options: LinearWebhookLocalBridgeOptions) {
    this.signingSecret = options.signingSecret;
    this.replayWindowMs = options.replayWindowMs ?? LINEAR_WEBHOOK_REPLAY_WINDOW_MS;
    this.clock = options.clock ?? Date.now;
    this.evidence = options.evidence ?? noopEvidence;

    const secretLength =
      typeof this.signingSecret === "string"
        ? Buffer.byteLength(this.signingSecret)
        : this.signingSecret.byteLength;
    if (secretLength < 16) throw new Error("Linear webhook signing secret is too short");
    if (!Number.isInteger(this.replayWindowMs) || this.replayWindowMs < 1) {
      throw new Error("Linear webhook replay window must be a positive integer");
    }
  }

  public async dial(transport: LinearWebhookOutboundTransport): Promise<LinearWebhookBridgeConnection> {
    const channel = await transport.dial();
    return new LinearWebhookBridgeConnection({
      channel,
      signingSecret: this.signingSecret,
      replayWindowMs: this.replayWindowMs,
      clock: this.clock,
      evidence: this.evidence,
    });
  }
}

interface LinearWebhookBridgeConnectionOptions {
  readonly channel: LinearWebhookDeliveryChannel;
  readonly signingSecret: string | Uint8Array;
  readonly replayWindowMs: number;
  readonly clock: () => number;
  readonly evidence: LinearWebhookEvidenceSink;
}

export class LinearWebhookBridgeConnection {
  private readonly channel: LinearWebhookDeliveryChannel;
  private readonly signingSecret: string | Uint8Array;
  private readonly replayWindowMs: number;
  private readonly clock: () => number;
  private readonly evidence: LinearWebhookEvidenceSink;

  public constructor(options: LinearWebhookBridgeConnectionOptions) {
    this.channel = options.channel;
    this.signingSecret = options.signingSecret;
    this.replayWindowMs = options.replayWindowMs;
    this.clock = options.clock;
    this.evidence = options.evidence;
  }

  public async processNext(consume: LinearWebhookConsumer): Promise<LinearWebhookBridgeOutcome> {
    const received = await this.channel.receive();
    if (received === null) return "idle";

    const lease = LinearWebhookLeasedDeliverySchema.safeParse(received.payload);
    if (!lease.success) {
      await this.channel.reject(received.receipt, "bridge_verification_failed");
      this.emit("rejected", "invalid_envelope");
      return "rejected";
    }

    const { deliveryId, attempt, envelope } = lease.data;
    const reject = async (reason: string): Promise<"rejected"> => {
      await this.channel.reject(received.receipt, "bridge_verification_failed");
      this.emit("rejected", reason, deliveryId, envelope.correlationId, attempt);
      return "rejected";
    };

    if (deliveryId !== envelope.deliveryId) return reject("delivery_id_mismatch");
    const rawBody = decodeLinearWebhookBody(envelope.rawBodyBase64);
    if (rawBody === undefined) return reject("invalid_raw_body");
    if (!verifyLinearWebhookSignature(rawBody, envelope.signature, this.signingSecret)) {
      return reject("invalid_signature");
    }

    const payload = decodePayload(rawBody);
    if (payload === undefined) return reject("invalid_agent_session_event");
    if (
      payload.type !== envelope.eventType ||
      payload.action !== envelope.action ||
      payload.webhookTimestamp !== envelope.timestampMs
    ) {
      return reject("envelope_metadata_mismatch");
    }

    const now = this.clock();
    if (now >= envelope.expiresAtMs || Math.abs(now - payload.webhookTimestamp) >= this.replayWindowMs) {
      return reject("replay_window");
    }

    this.emit("verified", undefined, deliveryId, envelope.correlationId, attempt);
    const event = VerifiedLinearAgentSessionEventSchema.parse({
      version: 1,
      kind: "linear.agent-session-event",
      deliveryId,
      correlationId: envelope.correlationId,
      receivedAtMs: envelope.receivedAtMs,
      payload,
    });

    try {
      await consume(event);
    } catch {
      const outcome = await this.channel.retry(received.receipt, "consumer_error");
      this.emit(
        outcome === "scheduled" ? "retry_scheduled" : "dead_lettered",
        "consumer_error",
        deliveryId,
        envelope.correlationId,
        attempt,
      );
      return outcome === "scheduled" ? "retry_scheduled" : "dead_lettered";
    }

    await this.channel.acknowledge(received.receipt);
    this.emit("delivered", undefined, deliveryId, envelope.correlationId, attempt);
    return "delivered";
  }

  public async close(): Promise<void> {
    await this.channel.close();
  }

  private emit(
    outcome: LinearWebhookEvidence["outcome"],
    reason?: string,
    deliveryId?: string,
    correlationId?: string,
    attempt?: number,
  ): void {
    this.evidence({
      service: "linear-webhook-local-bridge",
      outcome,
      timestampMs: this.clock(),
      ...(reason === undefined ? {} : { reason }),
      ...(deliveryId === undefined ? {} : { deliveryId }),
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(attempt === undefined ? {} : { attempt }),
    });
  }
}

function decodePayload(
  rawBody: Uint8Array,
): ReturnType<typeof LinearAgentSessionWebhookPayloadSchema.parse> | undefined {
  try {
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    const parsed = LinearAgentSessionWebhookPayloadSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
