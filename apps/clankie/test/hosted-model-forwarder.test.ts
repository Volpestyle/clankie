import { describe, expect, it, vi } from "vitest";
import type { HostedModelEndpoint } from "../src/hosted-body.ts";
import { startHostedModelForwarder } from "../src/hosted-model-forwarder.ts";

type Forward = (endpoint: HostedModelEndpoint, bytes: Uint8Array, signal?: AbortSignal) => Promise<Response>;

async function withForwarder(forward: Forward, run: (baseURL: string) => Promise<void>) {
  const forwardModel = vi.fn(forward);
  const forwarder = await startHostedModelForwarder({ client: { forwardModel } });
  try {
    expect(forwarder.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    await run(forwarder.baseURL);
  } finally {
    await forwarder.close();
  }
  return forwardModel;
}

describe("hosted model forwarder (VUH-1371)", () => {
  it("forwards the exact bytes of each model endpoint and relays the stream chunk by chunk", async () => {
    const body = '{"model":"default","stream":true,"input":"☃"}';
    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => (releaseSecond = resolve));
    const forwardModel = await withForwarder(
      async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("data: one\n\n"));
              await second;
              controller.enqueue(new TextEncoder().encode("data: two\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "leak=1" } },
        ),
      async (baseURL) => {
        const response = await fetch(`${baseURL}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer local" },
          body,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        expect(response.headers.get("set-cookie")).toBeNull();
        const reader = response.body!.getReader();
        // The first event arrives while the proxy is still holding the second: no buffering.
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: one\n\n");
        releaseSecond();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: two\n\n");
      },
    );
    expect(forwardModel).toHaveBeenCalledOnce();
    const [endpoint, bytes] = forwardModel.mock.calls[0]!;
    expect(endpoint).toBe("responses");
    expect(Buffer.from(bytes).toString("utf8")).toBe(body);
    // Only bytes cross: the caller's placeholder bearer never reaches the signer.
    expect(JSON.stringify(forwardModel.mock.calls[0])).not.toContain("Bearer");
  });

  it("marks the proxy's refusals as not retryable and keeps its reset date", async () => {
    await withForwarder(
      async () =>
        Response.json(
          {
            error: {
              message: "Your included model usage is used up.",
              type: "insufficient_quota",
              code: "allowance_exhausted",
            },
          },
          { status: 429, headers: { "x-clankie-allowance-resets-at": "2026-10-26" } },
        ),
      async (baseURL) => {
        const response = await fetch(`${baseURL}/chat/completions`, { method: "POST", body: "{}" });
        expect(response.status).toBe(429);
        expect(response.headers.get("x-should-retry")).toBe("false");
        expect(response.headers.get("x-clankie-allowance-resets-at")).toBe("2026-10-26");
        expect(await response.json()).toMatchObject({ error: { code: "allowance_exhausted" } });
      },
    );
  });

  it("refuses bodies over 2 MiB and other paths without a signed call", async () => {
    const forwardModel = await withForwarder(
      async () => Response.json({}),
      async (baseURL) => {
        const large = await fetch(`${baseURL}/responses`, {
          method: "POST",
          body: "x".repeat(2 * 1024 * 1024 + 1),
        });
        expect(large.status).toBe(413);
        expect((await fetch(`${baseURL}/embeddings`, { method: "POST", body: "{}" })).status).toBe(404);
        expect((await fetch(`${baseURL}/responses`)).status).toBe(404);
      },
    );
    expect(forwardModel).not.toHaveBeenCalled();
  });

  it("answers an unreachable proxy in OpenAI's error shape", async () => {
    await withForwarder(
      async () => {
        throw new Error("Fleet request unavailable");
      },
      async (baseURL) => {
        const response = await fetch(`${baseURL}/responses`, { method: "POST", body: "{}" });
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({ error: { code: "model_proxy_unreachable" } });
      },
    );
  });
});
