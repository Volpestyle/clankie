import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createConfiguredOllamaPaneClassifier,
  screenSignature,
  screenTail,
  TAIL_LINE_LIMIT,
  type LocalClassificationResult,
} from "../src/index.ts";

const fixtureDirectory = join(import.meta.dirname, "fixtures");

interface RecordedOllamaCall {
  readonly url: URL;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
}

function localFixtureResponse(tail: string): LocalClassificationResult {
  if (tail.includes("Tell me whether")) {
    return {
      classification: "awaiting_input_required",
      confidence: 0.94,
      questionSummary: "Wait for the other owner or proceed with the compatibility adapter?",
    };
  }
  if (tail.includes("Want me to also")) {
    return { classification: "finished_with_offer", confidence: 0.97 };
  }
  if (tail.includes("status 137")) {
    return { classification: "errored", confidence: 0.88 };
  }
  return { classification: "finished", confidence: 0.96 };
}

function recordingLocalOllama(): { fetchImpl: typeof fetch; calls: RecordedOllamaCall[] } {
  const calls: RecordedOllamaCall[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    if (init === undefined || typeof init.body !== "string") throw new Error("expected JSON request body");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const messages = body["messages"];
    if (!Array.isArray(messages)) throw new Error("expected messages");
    const userMessage = messages[1];
    if (typeof userMessage !== "object" || userMessage === null) throw new Error("expected user message");
    const content = (userMessage as Record<string, unknown>)["content"];
    if (typeof content !== "string") throw new Error("expected user content");
    const terminalInput = JSON.parse(content) as { terminalTail: string };
    const result = localFixtureResponse(terminalInput.terminalTail);
    const url =
      input instanceof URL
        ? input
        : input instanceof Request
          ? new URL(input.url)
          : new URL(input.toString());
    calls.push({ url, init, body });
    return new Response(
      JSON.stringify({ message: { role: "assistant", content: JSON.stringify(result) }, done: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { fetchImpl, calls };
}

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureDirectory, `${name}.txt`), "utf8");
}

describe("OllamaLocalPaneClassifier", () => {
  it.each([
    [
      "awaiting-input",
      {
        classification: "awaiting_input_required",
        confidence: 0.94,
        questionSummary: "Wait for the other owner or proceed with the compatibility adapter?",
      },
    ],
    ["closing-offer", { classification: "finished_with_offer", confidence: 0.97 }],
    ["finished", { classification: "finished", confidence: 0.96 }],
    ["errored", { classification: "errored", confidence: 0.88 }],
  ] as const)("classifies the %s fixture stably across adapter runs", async (name, expected) => {
    const text = await fixture(name);
    const request = { ...screenTail(text, TAIL_LINE_LIMIT), screenSignature: screenSignature(text) };
    const transport = recordingLocalOllama();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        createConfiguredOllamaPaneClassifier(
          {
            settle_classifier_model: "ollama/local-fixture-model",
            provider: { ollama: { options: { baseURL: "http://localhost:11434/v1" } } },
          },
          { fetchImpl: transport.fetchImpl },
        ).classify(request),
      ),
    );

    expect(results).toEqual([expected, expected, expected]);
    expect(transport.calls).toHaveLength(3);
    for (const call of transport.calls) {
      expect(call.url.toString()).toBe("http://localhost:11434/api/chat");
      expect(call.init.redirect).toBe("error");
      expect(new Headers(call.init.headers).has("authorization")).toBe(false);
      expect(call.body).toMatchObject({
        model: "local-fixture-model",
        stream: false,
        think: false,
        options: { temperature: 0, seed: 0 },
        format: {
          properties: {
            classification: {
              enum: ["finished", "awaiting_input_required", "finished_with_offer", "errored"],
            },
          },
        },
      });
    }
    expect(transport.calls.map((call) => JSON.stringify(call.body))).toEqual([
      JSON.stringify(transport.calls[0]?.body),
      JSON.stringify(transport.calls[0]?.body),
      JSON.stringify(transport.calls[0]?.body),
    ]);
  });

  it.each([
    "https://localhost:11434",
    "http://192.0.2.10:11434",
    "http://127.0.0.2:11434",
    "http://[::1]:11434",
    "http://ollama.example.invalid:11434",
    "http://user@localhost:11434",
    "http://localhost:11434/api",
    "http://localhost:11434?target=remote",
  ])("rejects non-pinned Ollama URL %s before transport", (baseURL) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() =>
      createConfiguredOllamaPaneClassifier(
        {
          settle_classifier_model: "ollama/local-model",
          provider: { ollama: { options: { baseURL } } },
        },
        { fetchImpl },
      ),
    ).toThrow(/loopback|origin|compatibility/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("defaults to numeric loopback and cannot follow a redirect", async () => {
    const transport = recordingLocalOllama();
    const classifier = createConfiguredOllamaPaneClassifier(
      { settle_classifier_model: "ollama/local-model" },
      { fetchImpl: transport.fetchImpl },
    );

    await classifier.classify({ tail: "complete", lineCount: 1, screenSignature: "a".repeat(64) });

    expect(transport.calls[0]?.url.toString()).toBe("http://127.0.0.1:11434/api/chat");
    expect(transport.calls[0]?.init.redirect).toBe("error");
  });

  it("rejects absent, non-Ollama, and explicit cloud model selection", () => {
    expect(() => createConfiguredOllamaPaneClassifier({})).toThrow("No settle_classifier_model");
    expect(() =>
      createConfiguredOllamaPaneClassifier({ settle_classifier_model: "openai/gpt-test" }),
    ).toThrow("loopback-only ollama provider");
    expect(() =>
      createConfiguredOllamaPaneClassifier({ settle_classifier_model: "ollama/gpt-oss:120b-cloud" }),
    ).toThrow("cloud model tags");
  });

  it("fails closed on malformed local runtime output", async () => {
    const classifier = createConfiguredOllamaPaneClassifier(
      { settle_classifier_model: "ollama/local-model" },
      {
        fetchImpl: vi.fn<typeof fetch>(
          async () => new Response(JSON.stringify({ message: { content: "not-json" } }), { status: 200 }),
        ),
      },
    );

    await expect(
      classifier.classify({ tail: "complete", lineCount: 1, screenSignature: "b".repeat(64) }),
    ).rejects.toThrow("Ollama classification was not valid JSON");
  });
});
