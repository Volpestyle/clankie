import { request as httpRequest } from "node:http";
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

describe("customer model loopback for hired pi workers (VUH-1373)", () => {
  type Target = Awaited<
    ReturnType<NonNullable<Parameters<typeof startHostedModelForwarder>[0]["customer"]>["resolve"]>
  >;
  const target = (api: string, apiKey: string, baseUrl = "https://api.provider.example/v1"): Target =>
    ({
      model: { id: "m", api, provider: "p", baseUrl },
      baseUrl,
      apiKey,
      headers: {},
    }) as unknown as Target;
  async function withLoopback(
    resolve: () => Promise<Target>,
    run: (base: string, upstream: ReturnType<typeof vi.fn<typeof fetch>>) => Promise<void>,
  ) {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response("data: ok\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const forwarder = await startHostedModelForwarder({
      client: { forwardModel: vi.fn(async () => Response.json({})) },
      customer: { resolve: vi.fn(resolve) },
      fetch: upstream,
    });
    try {
      await run(forwarder.baseURL.replace(/\/v1$/u, "/customer"), upstream);
    } finally {
      await forwarder.close();
    }
  }

  it("forwards the worker's exact request to the selected provider with the real key in place of the placeholder", async () => {
    await withLoopback(
      async () => target("openai-responses", "sk-real-customer"),
      async (base, upstream) => {
        const body = '{"model":"m","input":"hi","stream":true}';
        const response = await fetch(`${base}/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer local",
            "content-type": "application/json",
            "x-client-request-id": "r1",
          },
          body,
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("data: ok\n\n");
        const [url, init] = upstream.mock.calls[0]!;
        expect(String(url)).toBe("https://api.provider.example/v1/responses");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer sk-real-customer");
        expect(headers.get("x-client-request-id")).toBe("r1");
        expect(headers.get("host")).toBeNull();
        expect(Buffer.from(init?.body as Uint8Array).toString("utf8")).toBe(body);
      },
    );
  });

  it.each([
    ["anthropic-messages", "sk-ant-oat01-real", "claude_subscription_removed", "Anthropic API key"],
    [
      "openai-codex-responses",
      "old-chatgpt-token",
      "hosted_chatgpt_approval_required",
      "included model usage",
    ],
  ])(
    "refuses %s subscription forwarding before any provider request",
    async (api, key, code, alternative) => {
      await withLoopback(
        async () => target(api, key),
        async (base, upstream) => {
          const response = await fetch(`${base}/responses`, { method: "POST", body: "{}" });
          expect(response.status).toBe(403);
          expect(response.headers.get("x-should-retry")).toBe("false");
          const result = await response.json();
          expect(result.error.code).toBe(code);
          expect(result.error.message).toContain(alternative);
          expect(JSON.stringify(result)).not.toContain(key);
          expect(upstream).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("uses a credential replaced mid-run on the next call, without restarting the worker", async () => {
    let key = "sk-first";
    await withLoopback(
      async () => target("openai-completions", key),
      async (base, upstream) => {
        await fetch(`${base}/chat/completions`, { method: "POST", body: "{}" });
        key = "sk-rotated";
        await fetch(`${base}/chat/completions`, { method: "POST", body: "{}" });
        expect(
          upstream.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")),
        ).toEqual(["Bearer sk-first", "Bearer sk-rotated"]);
      },
    );
  });

  it("is not an open proxy: no other destination, no browser, POST only, and nothing without a customer model", async () => {
    await withLoopback(
      async () => target("openai-responses", "sk-real"),
      async (base, upstream) => {
        // Raw request lines: fetch would normalize these before they left the client.
        const raw = (path: string) =>
          new Promise<number>((resolve, reject) => {
            const url = new URL(base);
            const request = httpRequest(
              { host: url.hostname, port: url.port, method: "POST", path: `${url.pathname}${path}` },
              (answer) => {
                answer.resume();
                resolve(answer.statusCode ?? 0);
              },
            );
            request.on("error", reject);
            request.end("{}");
          });
        expect(await raw("/../v1/responses")).toBe(404);
        expect(await raw("/%2e%2e/admin")).toBe(404);
        expect(await raw("//evil.example/x")).toBe(404);
        expect((await fetch(`${base}/responses`)).status).toBe(404);
        expect(
          (
            await fetch(`${base}/responses`, {
              method: "POST",
              headers: { origin: "https://evil.example" },
              body: "{}",
            })
          ).status,
        ).toBe(403);
        expect(upstream).not.toHaveBeenCalled();
      },
    );
    await withLoopback(
      async () => undefined,
      async (base, upstream) => {
        const response = await fetch(`${base}/responses`, { method: "POST", body: "{}" });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "no_customer_model" } });
        expect(upstream).not.toHaveBeenCalled();
      },
    );
  });
});
