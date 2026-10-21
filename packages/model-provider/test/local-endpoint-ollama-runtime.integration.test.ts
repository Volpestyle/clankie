import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ClankieConfig } from "../src/config.ts";
import { localProviderConfig, servedLocalContextModel } from "../src/local-endpoint.ts";

interface PsCapture {
  readonly nothingLoaded: unknown;
  readonly ctx8kLoaded: unknown;
  readonly ctx64kLoaded: unknown;
}

const capture = JSON.parse(
  await readFile(new URL("./fixtures/ollama-0.30.10-ps.json", import.meta.url), "utf8"),
) as PsCapture;
const NATIVE = 262_144;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

/**
 * Replays Ollama's captured `/api/ps`: `loaded` is what it reports now, and a
 * load request (`POST /api/generate` without a prompt) moves it to `afterLoad`.
 * `ollama: false` is a runtime with no native API.
 */
async function serve(options: { ollama: boolean; loaded?: unknown; afterLoad?: unknown }) {
  const calls: string[] = [];
  let ps = options.loaded;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (options.ollama && request.method === "GET" && request.url === "/api/ps") {
        response.end(JSON.stringify(ps));
        return;
      }
      if (options.ollama && request.method === "POST" && request.url === "/api/generate") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { prompt?: string };
        if (body.prompt !== undefined) throw new Error("a load carries no prompt");
        ps = options.afterLoad;
        response.end(JSON.stringify({ done: true, done_reason: "load" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  cleanup.push(() => new Promise((closed) => server.close(() => closed())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  return { baseURL, calls };
}

function localConfig(baseURL: string, model: string): ClankieConfig {
  return {
    provider: {
      ollama: localProviderConfig({
        providerId: "ollama",
        baseURL,
        models: [{ id: model, context: NATIVE }],
      }),
    },
  } as ClankieConfig;
}

describe("the context a local runtime actually serves", () => {
  it("loads an unloaded Ollama model and narrows the window to the num_ctx it serves", async () => {
    const model = "vuh2647-qwen3-vl-8b-ctx8k:latest";
    const ollama = await serve({
      ollama: true,
      loaded: capture.nothingLoaded,
      afterLoad: capture.ctx8kLoaded,
    });

    const served = await servedLocalContextModel(localConfig(ollama.baseURL, model), {
      provider: "ollama",
      id: model,
      contextWindow: NATIVE,
    });

    expect(served.contextWindow).toBe(8_192);
    expect(ollama.calls).toEqual(["GET /api/ps", "POST /api/generate", "GET /api/ps"]);
  });

  it("reads a loaded model without loading it again", async () => {
    const model = "vuh2647-qwen3-vl-8b-ctx64k:latest";
    const ollama = await serve({ ollama: true, loaded: capture.ctx64kLoaded });

    const served = await servedLocalContextModel(localConfig(ollama.baseURL, model), {
      provider: "ollama",
      id: model,
      contextWindow: NATIVE,
    });

    expect(served.contextWindow).toBe(65_536);
    expect(ollama.calls).toEqual(["GET /api/ps"]);
  });

  it("keeps the declared window on a runtime without Ollama's API, and asks nothing of other providers", async () => {
    const other = await serve({ ollama: false });
    const local = await servedLocalContextModel(localConfig(other.baseURL, "qwen3:8b"), {
      provider: "ollama",
      id: "qwen3:8b",
      contextWindow: NATIVE,
    });
    const hosted = await servedLocalContextModel(
      { provider: { ollama: { npm: "@ai-sdk/openai-compatible", options: { baseURL: other.baseURL } } } },
      { provider: "ollama", id: "qwen3:8b", contextWindow: NATIVE },
    );

    expect(local.contextWindow).toBe(NATIVE);
    expect(hosted.contextWindow).toBe(NATIVE);
    expect(other.calls).toEqual(["GET /api/ps"]);
  });
});
