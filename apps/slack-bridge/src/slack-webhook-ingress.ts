import { randomUUID } from "node:crypto";
import {
  SLACK_WEBHOOK_MAX_BODY_BYTES,
  SLACK_WEBHOOK_REPLAY_WINDOW_MS,
  SlackWebhookPayloadSchema,
  slackTimestampWithinWindow,
  slackWebhookCorrelationId,
  verifySlackWebhookSignature,
  type SlackWebhookEvidenceSink,
} from "../../relay/src/slack-webhook-protocol.ts";
import type { SlackChannelAdapter } from "./slack-channel-adapter.ts";

export interface SlackWebhookIngressOptions {
  readonly signingSecret: string | Uint8Array;
  readonly adapter: SlackChannelAdapter;
  readonly clock?: () => number;
  readonly replayWindowMs?: number;
  readonly maxBodyBytes?: number;
  readonly evidence?: SlackWebhookEvidenceSink;
}

export interface SlackWebhookHttpResult {
  readonly status: number;
  readonly outcome: "accepted" | "challenge" | "rejected";
  /** Present only for the one-time URL verification handshake. */
  readonly challenge?: string;
}

/**
 * Verifies Slack deliveries and acknowledges them inside Slack's three-second
 * budget (ADR 0080).
 *
 * The turn runs detached on purpose. Slack retries anything it does not see
 * acknowledged, so awaiting a mission here would turn one slow instruction into
 * a retry storm and a duplicate turn for every retry.
 */
export class SlackWebhookIngress {
  private readonly options: SlackWebhookIngressOptions;
  private readonly clock: () => number;
  private pending = new Set<Promise<unknown>>();

  public constructor(options: SlackWebhookIngressOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => Date.now());
  }

  public async handle(request: {
    method: string;
    headers: Pick<Headers, "get">;
    rawBody: Uint8Array;
  }): Promise<SlackWebhookHttpResult> {
    const now = this.clock();
    const reject = (reason: string): SlackWebhookHttpResult => {
      this.options.evidence?.({
        service: "slack-webhook-ingress",
        outcome: "rejected",
        timestampMs: now,
        reason,
      });
      return { status: 401, outcome: "rejected" };
    };

    if (request.method !== "POST") return { status: 405, outcome: "rejected" };
    if (request.rawBody.byteLength > (this.options.maxBodyBytes ?? SLACK_WEBHOOK_MAX_BODY_BYTES)) {
      return reject("body_too_large");
    }
    const timestamp = request.headers.get("x-slack-request-timestamp");
    const signature = request.headers.get("x-slack-signature");
    if (!timestamp || !signature) return reject("signature_missing");
    // The window is checked first: a stale delivery is refused without spending
    // HMAC work, and the check is what makes a captured signature expire.
    if (
      !slackTimestampWithinWindow(
        timestamp,
        now,
        this.options.replayWindowMs ?? SLACK_WEBHOOK_REPLAY_WINDOW_MS,
      )
    ) {
      return reject("replay_window");
    }
    if (!verifySlackWebhookSignature(request.rawBody, timestamp, signature, this.options.signingSecret)) {
      return reject("signature_invalid");
    }

    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(request.rawBody).toString("utf8"));
    } catch {
      return reject("invalid_json");
    }
    const parsed = SlackWebhookPayloadSchema.safeParse(body);
    if (!parsed.success) return reject("unsupported_payload");

    if (parsed.data.type === "url_verification") {
      this.options.evidence?.({
        service: "slack-webhook-ingress",
        outcome: "challenge",
        timestampMs: now,
      });
      return { status: 200, outcome: "challenge", challenge: parsed.data.challenge };
    }

    const event = parsed.data;
    const deliveryId = randomUUID();
    this.options.evidence?.({
      service: "slack-webhook-ingress",
      outcome: "accepted",
      timestampMs: now,
      deliveryId,
      correlationId: slackWebhookCorrelationId(event.event_id),
    });
    this.track(this.options.adapter.handle(event));
    return { status: 200, outcome: "accepted" };
  }

  /** Awaits detached turns; tests use it instead of sleeping. */
  public async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
    }
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
}
