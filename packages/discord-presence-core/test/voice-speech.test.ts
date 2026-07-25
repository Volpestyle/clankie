import { describe, expect, it, vi } from "vitest";
import { OpenAiVoiceSpeechRuntime } from "../src/voice-speech.ts";

describe("OpenAI Discord voice speech runtime", () => {
  it("transcribes a memory-only WAV with the broker-resolved key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer sk-test-secret" });
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
      expect(form.get("response_format")).toBe("json");
      const file = form.get("file");
      expect(file).toBeInstanceOf(Blob);
      return Promise.resolve(Response.json({ text: "  hello   group " }));
    });
    const runtime = new OpenAiVoiceSpeechRuntime({ apiKey: "sk-test-secret", fetch });

    expect(await runtime.readiness()).toMatchObject({
      ready: true,
      provider: "openai",
      responseFormat: "pcm",
    });
    await expect(runtime.transcribe(Buffer.alloc(320))).resolves.toBe("hello group");
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.openai.com/v1/audio/transcriptions"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns bounded raw PCM without exposing the key in errors", async () => {
    const pcm = Buffer.from([1, 0, 2, 0]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(pcm, { status: 200, headers: { "content-type": "audio/pcm" } }));
    const runtime = new OpenAiVoiceSpeechRuntime({ apiKey: "sk-test-secret", fetch });
    const audio = await runtime.synthesize(" hello   there ");
    expect(audio.pcm24KhzMono).toEqual(pcm);
    const requestBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      model: "gpt-4o-mini-tts",
      voice: "marin",
      input: "hello there",
      response_format: "pcm",
    });
    expect(JSON.stringify(requestBody)).not.toContain("sk-test-secret");
  });

  it("fails closed on an oversized response and reports only the status", async () => {
    const tooLarge = (24_000 * 2 * 60 + 1).toString();
    const oversized = new OpenAiVoiceSpeechRuntime({
      apiKey: "sk-test-secret",
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response("denied secret body", { status: 200, headers: { "content-length": tooLarge } }),
        ),
    });
    await expect(oversized.synthesize("hello")).rejects.toThrow("byte limit");

    const denied = new OpenAiVoiceSpeechRuntime({
      apiKey: "sk-test-secret",
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response("credential details", { status: 401 })),
    });
    const error = await denied.transcribe(Buffer.alloc(320)).catch((cause: unknown) => String(cause));
    expect(error).toContain("status 401");
    expect(error).not.toContain("credential details");
    expect(error).not.toContain("sk-test-secret");
  });

  it("keeps the request timeout active until the response body settles", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
        const signal = init?.signal;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                signal?.addEventListener("abort", () => controller.error(new Error("stream aborted")), {
                  once: true,
                });
              },
            }),
          ),
        );
      });
      const runtime = new OpenAiVoiceSpeechRuntime({
        apiKey: "sk-test-secret",
        fetch,
        requestTimeoutMs: 1_000,
      });
      const settlement = expect(runtime.synthesize("hello")).rejects.toThrow("stream aborted");
      await vi.advanceTimersByTimeAsync(1_001);
      await settlement;
    } finally {
      vi.useRealTimers();
    }
  });
});
