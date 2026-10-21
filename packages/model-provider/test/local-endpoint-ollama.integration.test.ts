import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declareLocalProvider, LOCAL_CONTEXT_FALLBACK, probeLocalModels } from "../src/local-endpoint.ts";

interface OllamaCapture {
  readonly v1Models: unknown;
  readonly apiShow: Record<string, unknown>;
}

const capture = JSON.parse(
  await readFile(new URL("./fixtures/ollama-0.30.10.json", import.meta.url), "utf8"),
) as OllamaCapture;
// Clankie's first request on a fresh install, measured on qwen3-vl:8b (VUH-2623).
const FIRST_REQUEST_PROMPT_TOKENS = 31_995;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

/** Serves the captured Ollama answers, or a runtime that has no native `/api/show`. */
async function serve(ollama: boolean): Promise<string> {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url === "/v1/models") {
        response.end(JSON.stringify(capture.v1Models));
        return;
      }
      if (ollama && request.method === "POST" && request.url === "/api/show") {
        const { model } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
        const shown = capture.apiShow[model];
        response.statusCode = shown === undefined ? 404 : 200;
        response.end(JSON.stringify(shown ?? { error: `model '${model}' not found` }));
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
  return `http://127.0.0.1:${address.port}/v1`;
}

describe("local endpoint context discovery over HTTP", () => {
  it("declares each Ollama model at the window /api/show reports", async () => {
    const xdg = await mkdtemp(join(tmpdir(), "local-endpoint-ollama-"));
    cleanup.push(() => rm(xdg, { recursive: true, force: true }));
    const baseURL = await serve(true);

    const models = await probeLocalModels(baseURL);
    const config = await declareLocalProvider({
      providerId: "ollama",
      baseURL,
      models,
      env: { XDG_CONFIG_HOME: xdg },
    });

    const declared = config.provider?.["ollama"]?.models ?? {};
    expect(Object.keys(declared)).toHaveLength(8);
    expect(declared["qwen3-vl:8b"]).toEqual({ tool_call: true, limit: { context: 262_144, output: 8_192 } });
    expect(declared["glm-4.7-flash:latest"]).toEqual({
      tool_call: true,
      limit: { context: 202_752, output: 8_192 },
    });
    expect(declared["nomic-embed-text:latest"]).toEqual({
      tool_call: true,
      limit: { context: 2_048, output: 512 },
    });
  });

  it("leaves a runtime without /api/show at a fallback larger than Clankie's first request", async () => {
    const baseURL = await serve(false);

    const models = await probeLocalModels(baseURL);

    expect(models.every((model) => model.context === undefined)).toBe(true);
    expect(LOCAL_CONTEXT_FALLBACK).toBeGreaterThan(FIRST_REQUEST_PROMPT_TOKENS * 2);
  });
});
