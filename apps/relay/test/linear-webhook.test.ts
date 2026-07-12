import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LinearWebhookLocalBridge } from "../src/linear-webhook-bridge.ts";
import { LinearWebhookIngress, createLinearWebhookFetchHandler } from "../src/linear-webhook-ingress.ts";
import {
  LINEAR_AGENT_ACTIVITY_ACK_TARGET_MS,
  LINEAR_WEBHOOK_HTTP_DEADLINE_MS,
  LINEAR_WEBHOOK_MAX_BODY_BYTES,
  LINEAR_WEBHOOK_REPLAY_WINDOW_MS,
  LINEAR_WEBHOOK_RESPONSE_DEADLINE_MS,
  type LinearWebhookEvidence,
  type VerifiedLinearAgentSessionEvent,
} from "../src/linear-webhook-protocol.ts";
import {
  RetainedLinearWebhookQueue,
  type LinearWebhookDeliveryChannel,
  type LinearWebhookLeaseReceipt,
  type LinearWebhookOutboundTransport,
} from "../src/linear-webhook-queue.ts";

const signingSecret = "linear-webhook-test-secret";
const deliveryIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;

interface FixtureOptions {
  readonly capacity?: number;
  readonly retentionMs?: number;
  readonly retryDelaysMs?: readonly number[];
}

function fixture(options: FixtureOptions = {}) {
  let now = 1_800_000_000_000;
  const evidence: LinearWebhookEvidence[] = [];
  const clock = (): number => now;
  const sink = (entry: LinearWebhookEvidence): void => {
    evidence.push(entry);
  };
  const queue = new RetainedLinearWebhookQueue({
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    ...(options.retentionMs === undefined ? {} : { retentionMs: options.retentionMs }),
    ...(options.retryDelaysMs === undefined ? {} : { retryDelaysMs: options.retryDelaysMs }),
    clock,
    evidence: sink,
  });
  const ingress = new LinearWebhookIngress({
    signingSecret,
    queue,
    clock,
    evidence: sink,
  });
  const bridge = new LinearWebhookLocalBridge({
    signingSecret,
    clock,
    evidence: sink,
  });
  return {
    advance: (milliseconds: number): void => {
      now += milliseconds;
    },
    bridge,
    evidence,
    ingress,
    now: (): number => now,
    queue,
  };
}

function webhookBody(timestampMs: number, promptContext = "private-prompt-body"): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookTimestamp: timestampMs,
      webhookId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      agentSession: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        promptContext,
      },
    }),
  );
}

function request(rawBody: Uint8Array, timestampMs: number, deliveryId: string = deliveryIds[0]) {
  const signature = createHmac("sha256", signingSecret).update(rawBody).digest("hex");
  return {
    signature,
    value: {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json; charset=utf-8",
        "linear-delivery": deliveryId,
        "linear-event": "AgentSessionEvent",
        "linear-signature": signature,
        "linear-timestamp": String(timestampMs),
      }),
      rawBody,
    },
  } as const;
}

function streamingFetchRequest(contentLength?: string) {
  const chunkBytes = 64 * 1024;
  const totalChunks = 64;
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls === totalChunks) {
          controller.close();
          return;
        }
        pulls += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  const value = new Request("https://public.example.test/linear", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return {
    cancelled: (): boolean => cancelled,
    consumedBytes: (): number => pulls * chunkBytes,
    chunkBytes,
    totalBytes: totalChunks * chunkBytes,
    value,
  };
}

describe("Linear agent-session webhook ingress", () => {
  it("accepts the untouched production-shaped VUH-799 prompted payload", async () => {
    const rawBody = readFileSync(
      new URL(
        "../../../packages/tracker-connector/test/fixtures/agent-session-prompted.json",
        import.meta.url,
      ),
    );
    const payload = JSON.parse(rawBody.toString()) as {
      webhookTimestamp: number;
      agentActivity: { content: { body: string } };
    };
    const queue = new RetainedLinearWebhookQueue({ clock: () => payload.webhookTimestamp });
    const bridge = new LinearWebhookLocalBridge({
      signingSecret,
      clock: () => payload.webhookTimestamp,
    });
    const connection = await bridge.dial(queue);
    const ingress = new LinearWebhookIngress({
      signingSecret,
      queue,
      clock: () => payload.webhookTimestamp,
    });
    const signed = request(rawBody, payload.webhookTimestamp);
    let promptBody: string | undefined;

    expect(ingress.handle(signed.value)).toEqual({ status: 200, outcome: "accepted" });
    await expect(
      connection.processNext((event) => {
        if (event.payload.action === "prompted") {
          promptBody = event.payload.agentActivity.content.body;
        }
      }),
    ).resolves.toBe("delivered");
    expect(promptBody).toBe(payload.agentActivity.content.body);
    await connection.close();
  });

  it("cancels a stalled body and returns before Linear's five-second deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      const request = new Request("https://public.example.test/linear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const pending = createLinearWebhookFetchHandler(f.ingress, { responseDeadlineMs: 25 })(request);

      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toMatchObject({ status: 408 });
      expect(cancelled).toBe(true);
      expect(f.evidence).toContainEqual(
        expect.objectContaining({ outcome: "rejected", reason: "body_read_timeout" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a declared oversized Fetch body before consuming it", async () => {
    const f = fixture();
    const handle = vi.spyOn(f.ingress, "handle");
    const streamed = streamingFetchRequest(String(LINEAR_WEBHOOK_MAX_BODY_BYTES + 1));

    const response = await createLinearWebhookFetchHandler(f.ingress)(streamed.value);

    expect(response.status).toBe(413);
    expect(streamed.consumedBytes()).toBe(0);
    expect(streamed.cancelled()).toBe(true);
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ bodyReadError: "body_too_large" }));
    expect(handle.mock.calls[0]?.[0]).not.toHaveProperty("rawBody");
    expect(f.evidence).toContainEqual(
      expect.objectContaining({ outcome: "rejected", reason: "body_too_large" }),
    );
  });

  it.each([
    ["absent", undefined],
    ["misleading", "1"],
  ] as const)("hard-bounds a streaming Fetch body with %s Content-Length", async (_name, contentLength) => {
    const f = fixture();
    const handle = vi.spyOn(f.ingress, "handle");
    const streamed = streamingFetchRequest(contentLength);

    const response = await createLinearWebhookFetchHandler(f.ingress)(streamed.value);

    expect(response.status).toBe(413);
    expect(streamed.cancelled()).toBe(true);
    expect(streamed.consumedBytes()).toBe(LINEAR_WEBHOOK_MAX_BODY_BYTES + streamed.chunkBytes);
    expect(streamed.consumedBytes()).toBeLessThan(streamed.totalBytes);
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ bodyReadError: "body_too_large" }));
    expect(handle.mock.calls[0]?.[0]).not.toHaveProperty("rawBody");
    expect(f.evidence).toContainEqual(
      expect.objectContaining({ outcome: "rejected", reason: "body_too_large" }),
    );
  });

  it("delivers a typed event after independent edge and local verification", async () => {
    const f = fixture();
    const connection = await f.bridge.dial(f.queue);
    const signed = request(webhookBody(f.now()), f.now());
    const received: VerifiedLinearAgentSessionEvent[] = [];

    expect(f.ingress.handle(signed.value)).toEqual({ status: 200, outcome: "accepted" });
    expect(
      await connection.processNext((event) => {
        received.push(event);
      }),
    ).toBe("delivered");

    expect(received).toHaveLength(1);
    expect(received[0]?.deliveryId).toBe(deliveryIds[0]);
    expect(received[0]?.payload.type).toBe("AgentSessionEvent");
    expect(f.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: "linear-webhook-ingress", outcome: "accepted" }),
        expect.objectContaining({ service: "linear-webhook-local-bridge", outcome: "verified" }),
        expect.objectContaining({ service: "linear-webhook-local-bridge", outcome: "delivered" }),
      ]),
    );

    const serializedEvidence = JSON.stringify(f.evidence);
    expect(serializedEvidence).not.toContain("private-prompt-body");
    expect(serializedEvidence).not.toContain(signed.signature);
    await connection.close();
  });

  it("rejects tampered bytes at the edge", async () => {
    const f = fixture();
    const connection = await f.bridge.dial(f.queue);
    const original = webhookBody(f.now());
    const signed = request(original, f.now());
    const tampered = Buffer.from(original.toString().replace("private-prompt-body", "tampered-body"));

    expect(f.ingress.handle({ ...signed.value, rawBody: tampered })).toEqual({
      status: 401,
      outcome: "rejected",
    });
    expect(f.queue.snapshot().queued).toBe(0);
    expect(f.evidence).toContainEqual(
      expect.objectContaining({ outcome: "rejected", reason: "invalid_signature" }),
    );
    await connection.close();
  });

  it("rejects a correctly signed replay outside the 60 second window", async () => {
    const f = fixture();
    const connection = await f.bridge.dial(f.queue);
    const timestampMs = f.now() - LINEAR_WEBHOOK_REPLAY_WINDOW_MS;
    const signed = request(webhookBody(timestampMs), timestampMs);

    expect(f.ingress.handle(signed.value)).toEqual({ status: 401, outcome: "rejected" });
    expect(f.evidence).toContainEqual(
      expect.objectContaining({ outcome: "rejected", reason: "replay_window" }),
    );
    await connection.close();
  });

  it("does not promote an invalid delivery header into evidence identity", async () => {
    const f = fixture();
    const connection = await f.bridge.dial(f.queue);
    const signed = request(webhookBody(f.now()), f.now());
    signed.value.headers.set("linear-delivery", "attacker-controlled-not-a-uuid");

    expect(f.ingress.handle(signed.value)).toEqual({ status: 400, outcome: "rejected" });
    const rejection = f.evidence.find(
      (entry) => entry.outcome === "rejected" && entry.reason === "invalid_header",
    );
    expect(rejection).not.toHaveProperty("deliveryId");
    expect(rejection).not.toHaveProperty("correlationId");
    await connection.close();
  });

  it("deduplicates Linear-Delivery while retaining one event", async () => {
    const f = fixture();
    const connection = await f.bridge.dial(f.queue);
    const signed = request(webhookBody(f.now()), f.now());
    let deliveries = 0;

    expect(f.ingress.handle(signed.value).outcome).toBe("accepted");
    expect(f.ingress.handle(signed.value)).toEqual({ status: 200, outcome: "duplicate" });
    expect(
      await connection.processNext(() => {
        deliveries += 1;
      }),
    ).toBe("delivered");
    expect(
      await connection.processNext(() => {
        deliveries += 1;
      }),
    ).toBe("idle");
    expect(deliveries).toBe(1);
    await connection.close();
  });

  it("returns non-200 backpressure for a burst beyond capacity", async () => {
    const f = fixture({ capacity: 2 });
    const connection = await f.bridge.dial(f.queue);
    const first = request(webhookBody(f.now()), f.now(), deliveryIds[0]);
    const second = request(webhookBody(f.now()), f.now(), deliveryIds[1]);
    const third = request(webhookBody(f.now()), f.now(), deliveryIds[2]);

    expect(f.ingress.handle(first.value).status).toBe(200);
    expect(f.ingress.handle(second.value).status).toBe(200);
    expect(f.ingress.handle(third.value)).toEqual({
      status: 503,
      outcome: "backpressure",
      retryAfterSeconds: 60,
    });
    expect(await connection.processNext(() => undefined)).toBe("delivered");
    expect(f.ingress.handle(third.value).outcome).toBe("accepted");
    await connection.close();
  });

  it("returns non-200 while offline so Linear retries instead of dropping", async () => {
    const f = fixture();
    const signed = request(webhookBody(f.now()), f.now());

    expect(f.ingress.handle(signed.value)).toEqual({
      status: 503,
      outcome: "offline",
      retryAfterSeconds: 60,
    });
    expect(f.queue.snapshot().queued).toBe(0);

    const connection = await f.bridge.dial(f.queue);
    expect(f.ingress.handle(signed.value).outcome).toBe("accepted");
    expect(await connection.processNext(() => undefined)).toBe("delivered");
    await connection.close();
  });

  it("re-verifies the original signature in the local bridge", async () => {
    const f = fixture();
    const untrustedBridge = new LinearWebhookLocalBridge({
      signingSecret: "different-local-secret",
      clock: f.now,
      evidence: (entry) => f.evidence.push(entry),
    });
    const connection = await untrustedBridge.dial(f.queue);
    const signed = request(webhookBody(f.now()), f.now());

    expect(f.ingress.handle(signed.value).outcome).toBe("accepted");
    expect(await connection.processNext(() => expect.unreachable())).toBe("rejected");
    expect(f.evidence).toContainEqual(
      expect.objectContaining({
        service: "linear-webhook-local-bridge",
        outcome: "rejected",
        reason: "invalid_signature",
      }),
    );
    await connection.close();
  });

  it("rejects malformed hosted payloads through their opaque lease receipt", async () => {
    const receipt: LinearWebhookLeaseReceipt = Object.freeze({});
    const transitions = { acknowledge: 0, reject: 0, retry: 0 };
    const channel: LinearWebhookDeliveryChannel = {
      receive: async () => ({
        receipt,
        payload: { deliveryId: deliveryIds[0], attempt: 1, envelope: { deliveryId: deliveryIds[0] } },
      }),
      acknowledge: async () => {
        transitions.acknowledge += 1;
      },
      retry: async () => {
        transitions.retry += 1;
        return "scheduled";
      },
      reject: async (actualReceipt) => {
        expect(actualReceipt).toBe(receipt);
        transitions.reject += 1;
      },
      close: async () => undefined,
    };
    const transport: LinearWebhookOutboundTransport = { dial: async () => channel };
    const evidence: LinearWebhookEvidence[] = [];
    const bridge = new LinearWebhookLocalBridge({
      signingSecret,
      clock: () => 1_800_000_000_000,
      evidence: (entry) => evidence.push(entry),
    });
    const connection = await bridge.dial(transport);

    expect(await connection.processNext(() => expect.unreachable())).toBe("rejected");
    expect(transitions).toEqual({ acknowledge: 0, reject: 1, retry: 0 });
    expect(evidence).toContainEqual(
      expect.objectContaining({ outcome: "rejected", reason: "invalid_envelope" }),
    );
    await connection.close();
  });

  it("leases once across channels and releases the opaque receipt on disconnect", async () => {
    const f = fixture({ retryDelaysMs: [1_000] });
    const first = await f.queue.dial();
    const second = await f.queue.dial();
    const signed = request(webhookBody(f.now()), f.now());

    expect(f.ingress.handle(signed.value).outcome).toBe("accepted");
    const [firstDelivery, secondDelivery] = await Promise.all([first.receive(), second.receive()]);
    expect(Number(firstDelivery !== null) + Number(secondDelivery !== null)).toBe(1);

    const holder = firstDelivery === null ? second : first;
    const other = firstDelivery === null ? first : second;
    await expect(holder.receive()).rejects.toThrow("already has an outstanding lease");
    await holder.close();
    f.advance(1_000);

    const released = await other.receive();
    expect(released?.payload).toEqual(expect.objectContaining({ deliveryId: deliveryIds[0], attempt: 2 }));
    expect(released).not.toBeNull();
    await other.reject(released!.receipt, "bridge_verification_failed");
    expect(f.queue.snapshot()).toEqual({
      capacity: 64,
      connectedBridges: 1,
      queued: 0,
      inFlight: 0,
      delivered: 0,
      failed: 1,
    });
    expect(f.evidence).toContainEqual(
      expect.objectContaining({ outcome: "retry_scheduled", reason: "bridge_disconnected" }),
    );
    await other.close();
  });

  it("retries consumer failures deterministically within retention", async () => {
    const f = fixture({ retentionMs: 5_000, retryDelaysMs: [1_000] });
    const connection = await f.bridge.dial(f.queue);
    const signed = request(webhookBody(f.now()), f.now());
    let attempts = 0;

    expect(f.ingress.handle(signed.value).outcome).toBe("accepted");
    expect(
      await connection.processNext(() => {
        attempts += 1;
        throw new Error("fixture consumer failure");
      }),
    ).toBe("retry_scheduled");
    expect(await connection.processNext(() => undefined)).toBe("idle");
    f.advance(1_000);
    expect(
      await connection.processNext(() => {
        attempts += 1;
      }),
    ).toBe("delivered");
    expect(attempts).toBe(2);
    await connection.close();
  });

  it("records retained delivery expiry instead of silently discarding it", async () => {
    const f = fixture({ retentionMs: 2_000, retryDelaysMs: [500] });
    const connection = await f.bridge.dial(f.queue);
    const signed = request(webhookBody(f.now()), f.now());

    expect(f.ingress.handle(signed.value).outcome).toBe("accepted");
    f.advance(2_000);
    expect(await connection.processNext(() => expect.unreachable())).toBe("idle");
    expect(f.evidence).toContainEqual(
      expect.objectContaining({ outcome: "expired", reason: "retention_window" }),
    );
    await connection.close();
  });

  it("pins the externally documented response and acknowledgement timing", () => {
    expect(LINEAR_WEBHOOK_HTTP_DEADLINE_MS).toBe(5_000);
    expect(LINEAR_WEBHOOK_RESPONSE_DEADLINE_MS).toBe(4_500);
    expect(LINEAR_AGENT_ACTIVITY_ACK_TARGET_MS).toBe(10_000);
    expect(LINEAR_WEBHOOK_REPLAY_WINDOW_MS).toBe(60_000);
  });
});
