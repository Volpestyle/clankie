import { CatalogSchema } from "@clankie/model-registry";
import type { ModelRuntime, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerConfiguredPiProviders } from "../src/pi.ts";

describe("Pi provider projection", () => {
  it("registers a Clankie custom endpoint in Pi's native shape", () => {
    const registrations: Array<{ id: string; config: ProviderConfig }> = [];
    const runtime = {
      getProviders: () => [],
      registerProvider(id: string, config: ProviderConfig) {
        registrations.push({ id, config });
      },
    } as unknown as ModelRuntime;
    const catalog = CatalogSchema.parse({
      ollama: {
        id: "ollama",
        name: "Ollama",
        env: [],
        models: {
          qwen: {
            id: "qwen",
            name: "Qwen",
            reasoning: true,
            limit: { context: 32_000, output: 4_000 },
          },
        },
      },
    });

    registerConfiguredPiProviders(
      runtime,
      {
        provider: {
          ollama: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://localhost:11434/v1" },
            models: { qwen: {} },
          },
        },
      },
      catalog,
    );

    expect(registrations).toEqual([
      {
        id: "ollama",
        config: expect.objectContaining({
          api: "openai-completions",
          baseUrl: "http://localhost:11434/v1",
          models: [expect.objectContaining({ id: "qwen", contextWindow: 32_000 })],
        }),
      },
    ]);
  });
});
