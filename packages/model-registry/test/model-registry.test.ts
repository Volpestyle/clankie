import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCustomProviders,
  CatalogSchema,
  contextWindow,
  createModelRegistry,
  findModel,
  listModels,
  listProviders,
  loadBundledCatalog,
  ProviderEntrySchema,
  searchModels,
  supportsReasoning,
} from "../src/index.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "model-registry-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function must<T>(value: T | undefined, label = "value"): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

const remoteCatalog = {
  testprov: {
    id: "testprov",
    name: "Test Provider",
    env: ["TEST_API_KEY"],
    models: {
      "test-model": {
        id: "test-model",
        name: "Test Model",
        release_date: "2026-01-01",
        reasoning: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
};

function stubFetch(payload: unknown): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

function forbiddenFetch(): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    calls.push(String(input));
    throw new Error("network access is forbidden in this test");
  };
  return { impl, calls };
}

describe("loadBundledCatalog", () => {
  it("loads the vendored snapshot with known providers and models", () => {
    const catalog = loadBundledCatalog();
    for (const providerId of ["anthropic", "openai", "xai"]) {
      expect(catalog[providerId], providerId).toBeDefined();
    }
    const anthropic = must(catalog["anthropic"], "anthropic provider");
    expect(Object.keys(anthropic.models).length).toBeGreaterThanOrEqual(10);
    const opus = must(findModel(catalog, "anthropic", "claude-opus-4-5"), "claude-opus-4-5");
    expect(contextWindow(opus)).toBeGreaterThan(0);
    expect(supportsReasoning(opus)).toBe(true);
  });
});

describe("createModelRegistry", () => {
  it("catalog() falls back to the bundled snapshot when the cache dir is empty", async () => {
    const cacheDir = await makeTempDir();
    const { impl, calls } = forbiddenFetch();
    const registry = createModelRegistry({ cacheDir, env: {}, fetchImpl: impl });
    const catalog = await registry.catalog();
    expect(catalog["anthropic"]).toBeDefined();
    expect(calls).toEqual([]);
  });

  it("refresh(true) writes the disk cache and catalog() then serves it", async () => {
    const cacheDir = await makeTempDir();
    const { impl, calls } = stubFetch(remoteCatalog);
    const registry = createModelRegistry({
      cacheDir,
      env: {},
      fetchImpl: impl,
      url: "https://models.example.test",
    });

    const result = await registry.refresh(true);
    expect(result).toEqual({ updated: true, source: "network" });
    expect(calls).toEqual(["https://models.example.test/api.json"]);

    const envelope = JSON.parse(await readFile(join(cacheDir, "models.json"), "utf8")) as {
      fetchedAt: number;
      catalog: Record<string, unknown>;
    };
    expect(envelope.fetchedAt).toBeTypeOf("number");
    expect(Object.keys(envelope.catalog)).toEqual(["testprov"]);
    expect((await readdir(cacheDir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);

    const catalog = await registry.catalog();
    expect(must(catalog["testprov"]).name).toBe("Test Provider");
    expect(catalog["anthropic"]).toBeUndefined();
  });

  it("serves a stale-but-usable cache after TTL expiry and refetches on refresh()", async () => {
    const cacheDir = await makeTempDir();
    const { impl, calls } = stubFetch(remoteCatalog);
    let clock = 1_000_000;
    const registry = createModelRegistry({
      cacheDir,
      env: {},
      fetchImpl: impl,
      now: () => clock,
      url: "https://models.example.test",
    });

    await registry.refresh(true);
    expect(calls.length).toBe(1);

    // Within TTL an unforced refresh is a cache hit.
    expect(await registry.refresh()).toEqual({ updated: false, source: "cache" });
    expect(calls.length).toBe(1);

    // Past the 5 minute TTL the cache is stale but catalog() still prefers it over bundled.
    clock += 10 * 60 * 1000;
    const catalog = await registry.catalog();
    expect(catalog["testprov"]).toBeDefined();
    expect(catalog["anthropic"]).toBeUndefined();

    // ...while an unforced refresh now goes back to the network.
    expect(await registry.refresh()).toEqual({ updated: true, source: "network" });
    expect(calls.length).toBe(2);
  });

  it("CLANKIE_DISABLE_MODELS_FETCH short-circuits refresh without touching the network", async () => {
    const cacheDir = await makeTempDir();
    const { impl, calls } = forbiddenFetch();
    const registry = createModelRegistry({
      cacheDir,
      env: { CLANKIE_DISABLE_MODELS_FETCH: "1" },
      fetchImpl: impl,
    });
    expect(await registry.refresh(true)).toEqual({ updated: false, source: "bundled" });
    expect(calls).toEqual([]);
    const catalog = await registry.catalog();
    expect(catalog["anthropic"]).toBeDefined();
  });

  it("CLANKIE_MODELS_PATH wins over cache, network, and bundled", async () => {
    const cacheDir = await makeTempDir();
    const explicitDir = await makeTempDir();
    const explicitPath = join(explicitDir, "custom-models.json");
    await writeFile(explicitPath, JSON.stringify(remoteCatalog), "utf8");

    const { impl, calls } = forbiddenFetch();
    const registry = createModelRegistry({
      cacheDir,
      env: { CLANKIE_MODELS_PATH: explicitPath },
      fetchImpl: impl,
    });

    const catalog = await registry.catalog();
    expect(Object.keys(catalog)).toEqual(["testprov"]);
    expect(await registry.refresh(true)).toEqual({ updated: false, source: "cache" });
    expect(calls).toEqual([]);
  });

  it("CLANKIE_MODELS_URL overrides the configured URL", async () => {
    const cacheDir = await makeTempDir();
    const { impl, calls } = stubFetch(remoteCatalog);
    const registry = createModelRegistry({
      cacheDir,
      env: { CLANKIE_MODELS_URL: "https://override.example.test/" },
      fetchImpl: impl,
      url: "https://ignored.example.test",
    });

    await registry.refresh(true);
    expect(calls).toEqual(["https://override.example.test/api.json"]);
  });

  it("falls back to the stale cache when an explicit refresh fails", async () => {
    const cacheDir = await makeTempDir();
    const initial = stubFetch(remoteCatalog);
    const writer = createModelRegistry({ cacheDir, env: {}, fetchImpl: initial.impl });
    await writer.refresh(true);

    const failed = forbiddenFetch();
    const registry = createModelRegistry({ cacheDir, env: {}, fetchImpl: failed.impl });
    expect(await registry.refresh(true)).toEqual({ updated: false, source: "cache" });
    expect(failed.calls).toHaveLength(1);
    expect((await registry.catalog())["testprov"]).toBeDefined();
  });
});

describe("query helpers", () => {
  it("searchModels finds grok under xai", () => {
    const results = searchModels(loadBundledCatalog(), "GROK");
    expect(results.length).toBeGreaterThan(0);
    const xaiHit = results.find((match) => match.provider.id === "xai");
    expect(must(xaiHit).model.id.toLowerCase()).toContain("grok");
  });

  it("listModels sorts newest release_date first with undated models last", () => {
    const catalog = CatalogSchema.parse({
      p: {
        id: "p",
        name: "P",
        models: {
          old: { id: "old", name: "Old", release_date: "2025-01-01" },
          fresh: { id: "fresh", name: "Fresh", release_date: "2026-05-01" },
          undated: { id: "undated", name: "Undated" },
        },
      },
    });
    expect(listModels(catalog, "p").map((model) => model.id)).toEqual(["fresh", "old", "undated"]);
    expect(listModels(catalog, "missing")).toEqual([]);
  });

  it("listProviders sorts by display name", () => {
    const catalog = CatalogSchema.parse({
      b: { id: "b", name: "Beta", models: {} },
      a: { id: "a", name: "Alpha", models: {} },
    });
    expect(listProviders(catalog).map((provider) => provider.id)).toEqual(["a", "b"]);
  });
});

describe("applyCustomProviders", () => {
  it("adds an ollama provider with a custom model", () => {
    const catalog = loadBundledCatalog();
    const merged = applyCustomProviders(catalog, {
      ollama: {
        name: "Ollama (local)",
        api: "http://localhost:11434/v1",
        models: {
          "qwen3:32b": { limit: { context: 32768, output: 32768 }, tool_call: true },
        },
      },
    });
    const ollama = must(merged["ollama"]);
    expect(ollama.name).toBe("Ollama (local)");
    expect(ollama.api).toBe("http://localhost:11434/v1");
    const model = must(findModel(merged, "ollama", "qwen3:32b"));
    expect(model.name).toBe("qwen3:32b");
    expect(model.tool_call).toBe(true);
    expect(model.reasoning).toBe(false);
    expect(contextWindow(model)).toBe(32768);
    // Input catalog is not mutated.
    expect(catalog["ollama"]).toBeUndefined();
  });

  it("overrides an existing model's name while deep-merging the rest", () => {
    const catalog = loadBundledCatalog();
    const merged = applyCustomProviders(catalog, {
      anthropic: { models: { "claude-opus-4-5": { name: "Opus (custom)" } } },
    });
    const original = must(findModel(catalog, "anthropic", "claude-opus-4-5"));
    const overridden = must(findModel(merged, "anthropic", "claude-opus-4-5"));
    expect(overridden.name).toBe("Opus (custom)");
    expect(overridden.limit.context).toBe(original.limit.context);
    expect(overridden.cost).toEqual(original.cost);
    expect(original.name).not.toBe("Opus (custom)");
  });
});

describe("lenient parsing", () => {
  it("keeps unknown keys and defaults missing or malformed fields", () => {
    const provider = ProviderEntrySchema.parse({
      id: "mystery",
      name: "Mystery",
      brand_new_key: { nested: true },
      models: {
        bare: { id: "bare", name: "Bare", reasoning: "not-a-bool", surprise: "yes" },
      },
    });
    expect(provider["brand_new_key"]).toEqual({ nested: true });
    expect(provider.env).toEqual([]);
    const bare = must(provider.models["bare"]);
    expect(bare.reasoning).toBe(false);
    expect(bare.tool_call).toBe(false);
    expect(bare.temperature).toBe(true);
    expect(bare.attachment).toBe(false);
    expect(bare.limit).toEqual({ context: 0, output: 0 });
    expect(bare["surprise"]).toBe("yes");
  });

  it("recovers from malformed known fields and entries without rejecting the catalog", () => {
    const catalog = CatalogSchema.parse({
      malformed: {
        id: 42,
        name: null,
        env: "not-an-array",
        models: {
          broken: { id: 99, name: false, cost: "unknown", limit: "unknown" },
          notAnObject: "unknown",
        },
      },
      providerNotAnObject: "unknown",
    });

    const malformed = must(catalog["malformed"]);
    expect(malformed.id).toBe("");
    expect(malformed.name).toBe("");
    expect(malformed.env).toEqual([]);
    expect(must(malformed.models["broken"]).cost).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    });
    expect(must(malformed.models["notAnObject"]).id).toBe("");
    expect(must(catalog["providerNotAnObject"]).models).toEqual({});
  });
});
