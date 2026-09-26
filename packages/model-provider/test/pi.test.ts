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
          // Pi refuses to start a turn for a provider with no auth at all, so a
          // credential-less local endpoint carries a placeholder it ignores.
          apiKey: "local",
          models: [expect.objectContaining({ id: "qwen", contextWindow: 32_000 })],
        }),
      },
    ]);
  });

  it("leaves auth alone when the endpoint names an env var for its key", () => {
    const registrations: Array<{ id: string; config: ProviderConfig }> = [];
    const runtime = {
      getProviders: () => [],
      registerProvider(id: string, config: ProviderConfig) {
        registrations.push({ id, config });
      },
    } as unknown as ModelRuntime;

    registerConfiguredPiProviders(
      runtime,
      {
        provider: {
          vendor: {
            npm: "@ai-sdk/openai-compatible",
            env: ["VENDOR_API_KEY"],
            options: { baseURL: "https://vendor.example/v1" },
          },
        },
      },
      CatalogSchema.parse({}),
    );

    expect(registrations[0]?.config.apiKey).toBeUndefined();
  });

  it("keeps a declared provider's protocol when the same runtime projects it again", () => {
    // The model-keys service projects on every request into one runtime. The
    // second pass used to see Clankie's own registration as a Pi builtin and
    // re-register the provider with no api, which Pi refuses.
    const registered = new Map<string, ProviderConfig>();
    const runtime = {
      getProviders: () => [...registered.keys()].map((id) => ({ id })),
      registerProvider(id: string, config: ProviderConfig) {
        registered.set(id, config);
      },
    } as unknown as ModelRuntime;
    const config = {
      provider: {
        clankie: {
          npm: "@ai-sdk/openai",
          options: { baseURL: "http://127.0.0.1:4319/v1" },
          models: { default: { id: "default", limit: { context: 272_000, output: 8_192 } } },
        },
      },
    };

    registerConfiguredPiProviders(runtime, config, CatalogSchema.parse({}));
    registerConfiguredPiProviders(runtime, config, CatalogSchema.parse({}));

    // Naming OpenAI's own package asks for its Responses protocol.
    expect(registered.get("clankie")).toMatchObject({
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:4319/v1",
      apiKey: "local",
    });
  });
});
