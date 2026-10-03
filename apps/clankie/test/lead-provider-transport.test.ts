import { zstdCompressSync } from "node:zlib";
import { expect, test, vi } from "vitest";
// @ts-expect-error -- controller ESM, deterministic local fetch fixtures only.
import { createLeadTransport } from "../../../scripts/evals/lead-provider-transport.mjs";
const url = "https://chatgpt.com/backend-api/codex/responses";
const payload = () => ({
  model: "fixed-model",
  store: false,
  stream: true,
  instructions: "fixed",
  input: [{ role: "user", content: [{ type: "input_text", text: "fixture" }] }],
  text: { verbosity: "low" },
  include: ["reasoning.encrypted_content"],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "medium", summary: "auto" },
});
function fixture(stream?: ReadableStream<Uint8Array>) {
  const stop = vi.fn(async () => {}),
    admit = vi.fn(async () => {});
  const selectedCredential = vi.fn(async () => ({
    accountId: "account",
    accessToken: "fixture-secret-not-real",
    bindingSha256: "binding",
  }));
  const completion = {
    type: "response.completed",
    response: {
      status: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    },
  };
  const fetch = vi.fn(
    async () =>
      new Response(stream ?? `data: ${JSON.stringify(completion)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  const run = new AbortController();
  const assertCurrent = () => {
    if (run.signal.aborted) throw Error("revoked fixture");
  };
  const port = createLeadTransport({
    model: "fixed-model",
    effort: "medium",
    accountId: "account",
    selectedCredential,
    admit,
    assertCurrent,
    signal: run.signal,
    tools: [],
    stop,
    fetch,
  });
  const request = (compressed = false) => ({
    method: "POST",
    headers: {
      authorization: "Bearer fixture-secret-not-real",
      "chatgpt-account-id": "account",
      originator: "pi",
      "user-agent": "pi/fixture",
      "openai-beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
      ...(compressed ? { "content-encoding": "zstd" } : {}),
    },
    body: compressed ? zstdCompressSync(Buffer.from(JSON.stringify(payload()))) : JSON.stringify(payload()),
  });
  return { ...port, transport: fetch, stop, admit, selectedCredential, request, run };
}
test.each([false, true])(
  "final plain/zstd body and selected account admitted before physical send (%s)",
  async (compressed) => {
    const f = fixture();
    const response = await f.fetch(url, f.request(compressed));
    await response.text();
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.transport.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    expect(f.selectedCredential).toHaveBeenCalledTimes(2);
    expect(f.result()).toMatchObject({ complete: true, pending: [] });
    expect(JSON.stringify(f.result())).not.toContain("fixture-secret");
    expect(f.result().events.map((event: any) => event.type)).toEqual(["request", "usage", "settled"]);
  },
);
test.each(["url", "model", "effort", "image", "header", "encoding", "oversize"])(
  "final %s mismatch refuses without physical request",
  async (kind) => {
    const f = fixture(),
      request = f.request();
    const body: any = payload();
    if (kind === "model") body.model = "other";
    if (kind === "effort") body.reasoning.effort = "max";
    if (kind === "image") body.input[0].content = [{ type: "input_image", image_url: "file:///private" }];
    request.body =
      kind === "oversize" ? zstdCompressSync(Buffer.alloc(5 * 1024 * 1024)) : JSON.stringify(body);
    if (kind === "header") request.headers.authorization = "Bearer other";
    if (kind === "encoding" || kind === "oversize")
      Object.assign(request.headers, { "content-encoding": kind === "oversize" ? "zstd" : "gzip" });
    await expect(f.fetch(kind === "url" ? "https://other.invalid" : url, request)).rejects.toThrow("stopped");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledOnce();
  },
);
test("native credential change across quota admission refuses physical send", async () => {
  const f = fixture();
  f.selectedCredential.mockResolvedValueOnce({
    accountId: "account",
    accessToken: "fixture-secret-not-real",
    bindingSha256: "before",
  });
  await expect(f.fetch(url, f.request())).rejects.toThrow("stopped");
  expect(f.transport).not.toHaveBeenCalled();
});
test.each(["empty", "lost", "missing usage"])(
  "%s stream never becomes complete and stops boundary",
  async (kind) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (kind === "lost") controller.error(Error("fixture pipe lost"));
        else {
          if (kind === "missing usage")
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
              ),
            );
          controller.close();
        }
      },
    });
    const f = fixture(stream);
    const response = await f.fetch(url, f.request());
    await expect(response.text()).rejects.toThrow("stopped");
    expect(f.result().complete).toBe(false);
    expect(f.stop).toHaveBeenCalledOnce();
  },
);

test("stop during the last credential await cannot race a physical request", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.selectedCredential.mockImplementationOnce(async () => ({
    accountId: "account",
    accessToken: "fixture-secret-not-real",
    bindingSha256: "binding",
  }));
  f.selectedCredential.mockImplementationOnce(async () => {
    await gate;
    return { accountId: "account", accessToken: "fixture-secret-not-real", bindingSha256: "binding" };
  });
  const pending = f.fetch(url, f.request());
  await vi.waitFor(() => expect(f.selectedCredential).toHaveBeenCalledTimes(2));
  f.run.abort();
  release();
  await expect(pending).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledOnce();
});
test("allowed tool name cannot replace its controller-pinned schema", async () => {
  const f = fixture();
  const request = f.request();
  request.body = JSON.stringify({
    ...payload(),
    tools: [
      {
        type: "function",
        name: "read",
        parameters: { type: "object", properties: { escape: { type: "string" } } },
      },
    ],
  });
  await expect(f.fetch(url, request)).rejects.toThrow("stopped");
  expect(f.transport).not.toHaveBeenCalled();
});
