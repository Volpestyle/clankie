import {
  LINEAR_WEBHOOK_HTTP_DEADLINE_MS,
  LINEAR_WEBHOOK_MAX_BODY_BYTES,
  LINEAR_WEBHOOK_RESPONSE_DEADLINE_MS,
  LINEAR_WEBHOOK_REPLAY_WINDOW_MS,
  LinearAgentSessionWebhookPayloadSchema,
  linearWebhookCorrelationId,
  type LinearWebhookEnvelope,
  type LinearWebhookEvidence,
  type LinearWebhookEvidenceSink,
  verifyLinearWebhookSignature,
} from "./linear-webhook-protocol.ts";
import { RetainedLinearWebhookQueue } from "./linear-webhook-queue.ts";

interface LinearWebhookHttpRequestBase {
  readonly method: string;
  readonly headers: Pick<Headers, "get">;
}

export interface LinearWebhookHttpRequest extends LinearWebhookHttpRequestBase {
  readonly rawBody: Uint8Array;
  readonly bodyReadError?: never;
}

export interface LinearWebhookBodyReadFailure extends LinearWebhookHttpRequestBase {
  readonly bodyReadError: "body_read_timeout" | "body_too_large" | "invalid_content_length";
  readonly rawBody?: never;
}

export interface LinearWebhookFetchHandlerOptions {
  readonly responseDeadlineMs?: number;
}

export interface LinearWebhookHttpResult {
  readonly status: number;
  readonly outcome: "accepted" | "backpressure" | "duplicate" | "offline" | "rejected";
  readonly retryAfterSeconds?: number;
}

export interface LinearWebhookIngressOptions {
  readonly signingSecret: string | Uint8Array;
  readonly queue: RetainedLinearWebhookQueue;
  readonly replayWindowMs?: number;
  readonly maxBodyBytes?: number;
  readonly clock?: () => number;
  readonly evidence?: LinearWebhookEvidenceSink;
}

const noopEvidence: LinearWebhookEvidenceSink = () => undefined;
const retryAfterSeconds = 60;

/** Framework-neutral public HTTPS edge. The caller must pass the exact, unparsed request bytes. */
export class LinearWebhookIngress {
  public readonly maxBodyBytes: number;

  private readonly signingSecret: string | Uint8Array;
  private readonly queue: RetainedLinearWebhookQueue;
  private readonly replayWindowMs: number;
  private readonly clock: () => number;
  private readonly evidence: LinearWebhookEvidenceSink;

  public constructor(options: LinearWebhookIngressOptions) {
    this.signingSecret = options.signingSecret;
    this.queue = options.queue;
    this.replayWindowMs = options.replayWindowMs ?? LINEAR_WEBHOOK_REPLAY_WINDOW_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? LINEAR_WEBHOOK_MAX_BODY_BYTES;
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
    if (!Number.isInteger(this.maxBodyBytes) || this.maxBodyBytes < 1) {
      throw new Error("Linear webhook body limit must be a positive integer");
    }
    if (this.maxBodyBytes > LINEAR_WEBHOOK_MAX_BODY_BYTES) {
      throw new Error("Linear webhook body limit cannot exceed the envelope protocol limit");
    }
  }

  public handle(request: LinearWebhookHttpRequest | LinearWebhookBodyReadFailure): LinearWebhookHttpResult {
    const now = this.clock();
    const deliveryHeader = request.headers.get("linear-delivery") ?? undefined;
    const deliveryId = deliveryHeader !== undefined && isUuid(deliveryHeader) ? deliveryHeader : undefined;
    const correlationId = deliveryId === undefined ? undefined : linearWebhookCorrelationId(deliveryId);

    if (request.method.toUpperCase() !== "POST") {
      return this.reject(405, "method_not_allowed", now, deliveryId, correlationId);
    }
    if (request.bodyReadError !== undefined) {
      const status =
        request.bodyReadError === "body_too_large"
          ? 413
          : request.bodyReadError === "body_read_timeout"
            ? 408
            : 400;
      return this.reject(status, request.bodyReadError, now, deliveryId, correlationId);
    }
    if (request.rawBody.byteLength > this.maxBodyBytes) {
      return this.reject(413, "body_too_large", now, deliveryId, correlationId);
    }
    const contentType = request.headers.get("content-type")?.toLowerCase();
    if (contentType === undefined || !contentType.startsWith("application/json")) {
      return this.reject(415, "content_type", now, deliveryId, correlationId);
    }

    const signature = request.headers.get("linear-signature");
    const eventType = request.headers.get("linear-event");
    const timestampHeader = request.headers.get("linear-timestamp");
    if (
      deliveryHeader === undefined ||
      signature === null ||
      eventType === null ||
      timestampHeader === null
    ) {
      return this.reject(400, "missing_header", now, deliveryId, correlationId);
    }
    if (deliveryId === undefined || !/^\d{1,16}$/u.test(timestampHeader)) {
      return this.reject(400, "invalid_header", now, deliveryId, correlationId);
    }
    if (!verifyLinearWebhookSignature(request.rawBody, signature, this.signingSecret)) {
      return this.reject(401, "invalid_signature", now, deliveryId, correlationId);
    }

    const decoded = decodeJson(request.rawBody);
    const parsed = LinearAgentSessionWebhookPayloadSchema.safeParse(decoded);
    if (!parsed.success) {
      return this.reject(422, "invalid_agent_session_event", now, deliveryId, correlationId);
    }
    const payload = parsed.data;
    const timestampMs = Number(timestampHeader);
    if (eventType !== payload.type || timestampMs !== payload.webhookTimestamp) {
      return this.reject(401, "signed_metadata_mismatch", now, deliveryId, correlationId);
    }
    if (Math.abs(now - timestampMs) >= this.replayWindowMs) {
      return this.reject(401, "replay_window", now, deliveryId, correlationId);
    }

    const envelope: LinearWebhookEnvelope = {
      version: 1,
      kind: "linear.agent-session-webhook",
      deliveryId,
      correlationId: linearWebhookCorrelationId(deliveryId),
      eventType: payload.type,
      action: payload.action,
      timestampMs,
      receivedAtMs: now,
      expiresAtMs: Math.min(now + this.queue.retentionMs, timestampMs + this.replayWindowMs),
      signature: signature.toLowerCase(),
      rawBodyBase64: Buffer.from(request.rawBody).toString("base64"),
    };

    const outcome = this.queue.enqueue(envelope);
    if (outcome === "offline" || outcome === "backpressure") {
      return { status: 503, outcome, retryAfterSeconds };
    }
    if (outcome === "duplicate") return { status: 200, outcome };
    return { status: 200, outcome: "accepted" };
  }

  private reject(
    status: number,
    reason: string,
    timestampMs: number,
    deliveryId?: string,
    correlationId?: string,
  ): LinearWebhookHttpResult {
    const evidence: LinearWebhookEvidence = {
      service: "linear-webhook-ingress",
      outcome: "rejected",
      timestampMs,
      reason,
      ...(deliveryId === undefined ? {} : { deliveryId }),
      ...(correlationId === undefined ? {} : { correlationId }),
    };
    this.evidence(evidence);
    return { status, outcome: "rejected" };
  }
}

export function createLinearWebhookFetchHandler(
  ingress: LinearWebhookIngress,
  options: LinearWebhookFetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const responseDeadlineMs = options.responseDeadlineMs ?? LINEAR_WEBHOOK_RESPONSE_DEADLINE_MS;
  if (
    !Number.isInteger(responseDeadlineMs) ||
    responseDeadlineMs < 1 ||
    responseDeadlineMs >= LINEAR_WEBHOOK_HTTP_DEADLINE_MS
  ) {
    throw new Error("Linear webhook response deadline must be a positive integer below 5 seconds");
  }
  return async (request): Promise<Response> => {
    if (request.method.toUpperCase() !== "POST") {
      cancelBody(request.body);
      return responseFor(
        ingress.handle({ method: request.method, headers: request.headers, rawBody: new Uint8Array() }),
      );
    }

    const body = await readBoundedRequestBody(request, ingress.maxBodyBytes, responseDeadlineMs);
    const result = body.ok
      ? ingress.handle({ method: request.method, headers: request.headers, rawBody: body.rawBody })
      : ingress.handle({
          method: request.method,
          headers: request.headers,
          bodyReadError: body.reason,
        });
    return responseFor(result);
  };
}

type BoundedBodyResult =
  | { readonly ok: true; readonly rawBody: Uint8Array }
  | {
      readonly ok: false;
      readonly reason: LinearWebhookBodyReadFailure["bodyReadError"];
    };

async function readBoundedRequestBody(
  request: Request,
  maxBodyBytes: number,
  responseDeadlineMs: number,
): Promise<BoundedBodyResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      cancelBody(request.body);
      return { ok: false, reason: "invalid_content_length" };
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) {
      cancelBody(request.body);
      return { ok: false, reason: "invalid_content_length" };
    }
    if (declaredBytes > maxBodyBytes) {
      cancelBody(request.body);
      return { ok: false, reason: "body_too_large" };
    }
  }

  if (request.body === null) return { ok: true, rawBody: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const deadlineSignal = Symbol("linear_webhook_body_deadline");
  let timedOut = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof deadlineSignal>((resolve) => {
    deadlineTimer = setTimeout(() => resolve(deadlineSignal), responseDeadlineMs);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === deadlineSignal) {
        timedOut = true;
        cancelReader(reader, "linear_webhook_body_timeout");
        return { ok: false, reason: "body_read_timeout" };
      }
      if (next.done) break;
      if (next.value.byteLength > maxBodyBytes - totalBytes) {
        cancelReader(reader, "linear_webhook_body_too_large");
        return { ok: false, reason: "body_too_large" };
      }
      chunks.push(next.value);
      totalBytes += next.value.byteLength;
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (!timedOut) reader.releaseLock();
  }

  const rawBody = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    rawBody.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, rawBody };
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body === null) return;
  void body.cancel("linear_webhook_body_rejected").catch(() => undefined);
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: string): void {
  void reader.cancel(reason).catch(() => undefined);
}

function responseFor(result: LinearWebhookHttpResult): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (result.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(result.retryAfterSeconds));
  }
  return new Response(null, { status: result.status, headers });
}

function decodeJson(rawBody: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return undefined;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
