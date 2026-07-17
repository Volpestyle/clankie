import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CatalogSchema, findModel, ProviderEntrySchema } from "@clankie/model-registry";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClankieConfigSchema,
  findRepoConfigPath,
  formatModelRef,
  globalConfigPath,
  loadConfig,
  parseModelRef,
  updateGlobalConfig,
} from "../src/config.ts";
import { createLanguageModel, providerFamilyFor, variantProviderOptions } from "../src/instantiate.ts";
import { mergedCatalog, resolveProviders, resolveRole } from "../src/resolve.ts";
import { effortVariantsFor, variantById } from "../src/variants.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "model-provider-test-"));
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

/** Isolated global-config home; returned env never touches the real HOME. */
async function makeConfigEnv(): Promise<{ env: NodeJS.ProcessEnv; globalPath: string }> {
  const xdg = await makeTempDir();
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: xdg };
  return { env, globalPath: globalConfigPath(env) };
}

const fakeCatalog = CatalogSchema.parse({
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-test": { id: "claude-test", name: "Claude Test", reasoning: true, tool_call: true },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: {
      "gpt-test": { id: "gpt-test", name: "GPT Test", reasoning: true },
      "gpt-basic": { id: "gpt-basic", name: "GPT Basic", reasoning: false },
    },
  },
  xai: {
    id: "xai",
    name: "xAI",
    env: ["XAI_API_KEY"],
    npm: "@ai-sdk/xai",
    models: {
      "grok-test": { id: "grok-test", name: "Grok Test", reasoning: true },
    },
  },
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("returns an empty config with no issues when neither file exists", async () => {
    const { env } = await makeConfigEnv();
    const cwd = await makeTempDir();
    const result = await loadConfig({ cwd, env });
    expect(result.config).toEqual({});
    expect(result.sources).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("deep-merges repo config over global: scalars/arrays replace, objects merge", async () => {
    const { env, globalPath } = await makeConfigEnv();
    await writeJson(globalPath, {
      model: "anthropic/claude-test",
      small_model: "openai/gpt-test",
      disabled_providers: ["xai", "google"],
      provider: { ollama: { name: "Ollama Global", options: { baseURL: "http://global:11434/v1" } } },
    });
    const repoDir = await makeTempDir();
    const repoPath = join(repoDir, ".clankie.json");
    await writeJson(repoPath, {
      model: "openai/gpt-test",
      disabled_providers: ["zed"],
      provider: { ollama: { options: { baseURL: "http://repo:11434/v1" } } },
    });
    const nested = join(repoDir, "src", "deeply", "nested");
    await mkdir(nested, { recursive: true });

    const result = await loadConfig({ cwd: nested, env });
    expect(result.sources).toEqual([globalPath, repoPath]);
    expect(result.issues).toEqual([]);
    expect(result.config.model).toBe("openai/gpt-test");
    expect(result.config.small_model).toBe("openai/gpt-test");
    expect(result.config.disabled_providers).toEqual(["zed"]);
    const ollama = must(result.config.provider?.["ollama"], "ollama provider config");
    expect(ollama.name).toBe("Ollama Global");
    expect(ollama.options).toEqual({ baseURL: "http://repo:11434/v1" });
  });

  it("reports unparseable JSON as an issue and skips the file", async () => {
    const { env, globalPath } = await makeConfigEnv();
    await mkdir(dirname(globalPath), { recursive: true });
    await writeFile(globalPath, "{ not json", "utf8");
    const cwd = await makeTempDir();
    const result = await loadConfig({ cwd, env });
    expect(result.config).toEqual({});
    expect(result.sources).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(must(result.issues[0]).path).toBe(globalPath);
    expect(must(result.issues[0]).message).toContain("Invalid JSON");
  });

  it("rejects secret-shaped provider option keys with a pointer to /auth and the broker", async () => {
    const { env, globalPath } = await makeConfigEnv();
    await writeJson(globalPath, {
      provider: { openai: { options: { apiKey: "sk-oops" } } },
    });
    const cwd = await makeTempDir();
    const result = await loadConfig({ cwd, env });
    expect(result.config).toEqual({});
    expect(result.sources).toEqual([]);
    expect(result.issues).toHaveLength(1);
    const message = must(result.issues[0]).message;
    expect(message).toContain("/auth");
    expect(message).toContain("credential broker");
  });
});

describe("ClankieConfigSchema", () => {
  it.each([
    "apiKey",
    "api_key",
    "API_KEY",
    "api-key",
    "x-api-key",
    "Authorization",
    "authorization",
    "token",
    "accessToken",
    "refresh_token",
    "secret",
    "clientSecret",
  ])("rejects provider option key %s", (key) => {
    const result = ClankieConfigSchema.safeParse({
      provider: { some: { options: { [key]: "secret" } } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts non-secret provider options and unknown top-level keys", () => {
    const result = ClankieConfigSchema.safeParse({
      future_key: true,
      provider: { ollama: { options: { baseURL: "http://localhost:11434/v1", timeout: 5000 } } },
    });
    expect(result.success).toBe(true);
  });
});

describe("findRepoConfigPath", () => {
  it("returns undefined when no .clankie.json exists up the tree", async () => {
    const dir = await makeTempDir();
    // tmpdir ancestors realistically never hold a .clankie.json.
    expect(findRepoConfigPath(dir)).toBeUndefined();
  });
});

describe("updateGlobalConfig", () => {
  it.each([
    {
      location: "loose top-level config",
      config: { access_token: "top-access", refresh_token: "top-refresh" },
      pathPrefix: [],
    },
    {
      location: "provider options",
      config: {
        provider: {
          custom: { options: { access_token: "options-access", refresh_token: "options-refresh" } },
        },
      },
      pathPrefix: ["provider", "custom", "options"],
    },
    {
      location: "model overlay",
      config: {
        provider: {
          custom: {
            models: {
              "model-a": { access_token: "model-access", refresh_token: "model-refresh" },
            },
          },
        },
      },
      pathPrefix: ["provider", "custom", "models", "model-a"],
    },
    {
      location: "model-overlay metadata",
      config: {
        provider: {
          custom: {
            models: {
              "model-a": {
                metadata: { access_token: "metadata-access", refresh_token: "metadata-refresh" },
              },
            },
          },
        },
      },
      pathPrefix: ["provider", "custom", "models", "model-a", "metadata"],
    },
  ])(
    "rejects access and refresh tokens in $location instead of serializing them",
    async ({ config, pathPrefix }) => {
      const { env, globalPath } = await makeConfigEnv();

      await expect(updateGlobalConfig(() => config, { env })).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: [...pathPrefix, "access_token"] }),
          expect.objectContaining({ path: [...pathPrefix, "refresh_token"] }),
        ]),
      });
      await expect(readFile(globalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects nested authorization headers instead of serializing them", async () => {
    const { env, globalPath } = await makeConfigEnv();
    const marker = "Bearer fake-test-marker";

    await expect(
      updateGlobalConfig(
        () => ({ provider: { custom: { options: { headers: { authorization: marker } } } } }),
        { env },
      ),
    ).rejects.toMatchObject({
      issues: [
        {
          path: ["provider", "custom", "options", "headers", "authorization"],
          message: expect.stringMatching(/\/auth.*credential broker/i),
        },
      ],
    });
    await expect(readFile(globalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies both of two concurrent updates via the queue, atomically", async () => {
    const { env, globalPath } = await makeConfigEnv();
    const [first, second] = await Promise.all([
      updateGlobalConfig(
        (config) => {
          config.model = "anthropic/claude-test";
        },
        { env },
      ),
      updateGlobalConfig(
        (config) => {
          config.small_model = "openai/gpt-test";
        },
        { env },
      ),
    ]);
    expect(first.model).toBe("anthropic/claude-test");
    expect(second).toEqual({ model: "anthropic/claude-test", small_model: "openai/gpt-test" });

    const raw = await readFile(globalPath, "utf8");
    expect(JSON.parse(raw)).toEqual({ model: "anthropic/claude-test", small_model: "openai/gpt-test" });
    expect(raw).toContain('\n  "model"'); // pretty-printed
    expect(raw.endsWith("\n")).toBe(true);
    const leftovers = (await readdir(dirname(globalPath))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("supports mutators that return a replacement config", async () => {
    const { env } = await makeConfigEnv();
    await updateGlobalConfig(
      (config) => {
        config.model = "anthropic/claude-test";
      },
      { env },
    );
    const next = await updateGlobalConfig(() => ({ voice_model: "openai/gpt-test" }), { env });
    expect(next).toEqual({ voice_model: "openai/gpt-test" });
  });
});

describe("parseModelRef / formatModelRef", () => {
  it("splits on the first slash so model ids may contain slashes", () => {
    const ref = parseModelRef("fireworks/accounts/x/models/y");
    expect(ref).toEqual({ providerId: "fireworks", modelId: "accounts/x/models/y" });
    expect(formatModelRef(must(ref))).toBe("fireworks/accounts/x/models/y");
  });

  it.each(["no-slash", "/leading", "trailing/", ""])("returns undefined for %j", (ref) => {
    expect(parseModelRef(ref)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

describe("mergedCatalog", () => {
  it("overlays config providers and model patches onto the catalog", () => {
    const catalog = mergedCatalog(
      {
        provider: {
          ollama: {
            name: "Ollama",
            npm: "@ai-sdk/openai-compatible",
            models: { "llama-test": { reasoning: true, tool_call: true } },
          },
          anthropic: { models: { "claude-test": { name: "Claude Renamed" } } },
        },
      },
      fakeCatalog,
    );
    const llama = must(findModel(catalog, "ollama", "llama-test"), "llama-test");
    expect(llama.reasoning).toBe(true);
    expect(must(catalog["ollama"]).npm).toBe("@ai-sdk/openai-compatible");
    expect(must(findModel(catalog, "anthropic", "claude-test")).name).toBe("Claude Renamed");
    // Input catalog is untouched.
    expect(findModel(fakeCatalog, "ollama", "llama-test")).toBeUndefined();
  });
});

describe("resolveProviders", () => {
  it("marks credential and env connections and sorts connected providers first", () => {
    const resolved = resolveProviders({
      config: {},
      catalog: fakeCatalog,
      credentialIds: ["xai"],
      env: { OPENAI_API_KEY: "sk-env" },
    });
    expect(resolved.map((provider) => provider.id)).toEqual(["openai", "xai", "anthropic", "openai-codex"]);
    expect(resolved.map((provider) => provider.connection)).toEqual(["env", "credential", "none", "none"]);
    expect(resolved.map((provider) => provider.connected)).toEqual([true, true, false, false]);
    expect(resolved.every((provider) => !provider.declaredInConfig)).toBe(true);
  });

  it("keeps OpenAI API-key and ChatGPT subscription credentials explicit and independent", () => {
    const resolved = resolveProviders({
      config: {},
      catalog: fakeCatalog,
      credentialIds: ["openai-codex"],
      env: {},
    });
    expect(resolved.find((provider) => provider.id === "openai-codex")).toMatchObject({
      connected: true,
      connection: "credential",
    });
    expect(resolved.find((provider) => provider.id === "openai")).toMatchObject({
      connected: false,
      connection: "none",
    });
  });

  it("drops disabled providers and honors the enabled allowlist", () => {
    const disabled = resolveProviders({
      config: { disabled_providers: ["anthropic"] },
      catalog: fakeCatalog,
      credentialIds: [],
      env: {},
    });
    expect(disabled.map((provider) => provider.id)).not.toContain("anthropic");

    const allowlisted = resolveProviders({
      config: { enabled_providers: ["openai"] },
      catalog: fakeCatalog,
      credentialIds: [],
      env: {},
    });
    expect(allowlisted.map((provider) => provider.id)).toEqual(["openai"]);
  });

  it("includes config-declared custom providers with declaredInConfig set", () => {
    const resolved = resolveProviders({
      config: { provider: { ollama: { name: "Ollama", models: { "llama-test": {} } } } },
      catalog: fakeCatalog,
      credentialIds: ["ollama"],
      env: {},
    });
    const ollama = must(
      resolved.find((provider) => provider.id === "ollama"),
      "ollama",
    );
    expect(ollama.declaredInConfig).toBe(true);
    expect(ollama.connection).toBe("credential");
    expect(must(resolved[0]).id).toBe("ollama"); // only connected provider sorts first
  });
});

describe("resolveRole", () => {
  it("resolves ref, catalog model, and configured variant", () => {
    const config = {
      model: "anthropic/claude-test",
      variant: { "anthropic/claude-test": "think-16k" },
    };
    const resolved = must(resolveRole("model", { config, catalog: fakeCatalog }));
    expect(resolved.providerId).toBe("anthropic");
    expect(resolved.modelId).toBe("claude-test");
    expect(must(resolved.model).name).toBe("Claude Test");
    expect(resolved.variantId).toBe("think-16k");
  });

  it("returns undefined for unset roles and keeps unknown models as undefined", () => {
    expect(resolveRole("voice_model", { config: {}, catalog: fakeCatalog })).toBeUndefined();
    const resolved = must(
      resolveRole("small_model", { config: { small_model: "openai/does-not-exist" }, catalog: fakeCatalog }),
    );
    expect(resolved.model).toBeUndefined();
    expect(resolved.variantId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// variants
// ---------------------------------------------------------------------------

function fakeModel(id: string, reasoning: boolean) {
  return must(
    findModel(
      CatalogSchema.parse({ p: { id: "p", name: "P", models: { [id]: { id, name: id, reasoning } } } }),
      "p",
      id,
    ),
  );
}

describe("effortVariantsFor", () => {
  it("returns no variants for non-reasoning models", () => {
    expect(effortVariantsFor("openai", fakeModel("gpt-basic", false))).toEqual([]);
    expect(effortVariantsFor("anthropic", fakeModel("claude-basic", false))).toEqual([]);
  });

  it("emits reasoning_effort tiers for the openai family, with minimal for gpt-5", () => {
    const base = effortVariantsFor("openai", fakeModel("gpt-test", true));
    expect(base.map((variant) => variant.id)).toEqual(["low", "medium", "high"]);
    expect(must(base[0]).body).toEqual({ reasoning_effort: "low" });

    const gpt5 = effortVariantsFor("openai", fakeModel("gpt-5-test", true));
    expect(gpt5.map((variant) => variant.id)).toEqual(["minimal", "low", "medium", "high"]);

    const gpt55 = effortVariantsFor("openai-codex", fakeModel("gpt-5.5", true));
    expect(gpt55.map((variant) => variant.id)).toEqual(["low", "medium", "high"]);

    const compatible = effortVariantsFor("openai-compatible", fakeModel("some-reasoner", true));
    expect(compatible.map((variant) => variant.id)).toEqual(["low", "medium", "high"]);
  });

  it("emits thinking budgets for anthropic", () => {
    const variants = effortVariantsFor("anthropic", fakeModel("claude-test", true));
    expect(variants.map((variant) => variant.id)).toEqual(["think-8k", "think-16k", "think-32k"]);
    expect(must(variants[0]).body).toEqual({ thinking: { type: "enabled", budget_tokens: 8_000 } });
    expect(must(variants[2]).body).toEqual({ thinking: { type: "enabled", budget_tokens: 32_000 } });
  });

  it("emits low/high for xai and thinkingConfig budgets for google", () => {
    const xai = effortVariantsFor("xai", fakeModel("grok-test", true));
    expect(xai.map((variant) => variant.id)).toEqual(["low", "high"]);
    expect(must(xai[1]).body).toEqual({ reasoning_effort: "high" });

    const google = effortVariantsFor("google", fakeModel("gemini-test", true));
    expect(google.map((variant) => variant.id)).toEqual(["think-8k", "think-16k", "think-24k"]);
    expect(must(google[0]).body).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingBudget: 8_192 },
    });
  });

  it("falls back to low/medium/high for unknown reasoning providers", () => {
    const variants = effortVariantsFor("acme", fakeModel("acme-reasoner", true));
    expect(variants.map((variant) => variant.id)).toEqual(["low", "medium", "high"]);
  });
});

describe("variantById", () => {
  it("finds variants by id", () => {
    const variants = effortVariantsFor("anthropic", fakeModel("claude-test", true));
    expect(must(variantById(variants, "think-16k")).id).toBe("think-16k");
    expect(variantById(variants, "nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// instantiate
// ---------------------------------------------------------------------------

interface InspectableModel {
  modelId: string;
  provider: string;
  config: {
    headers: () => Record<string, string | undefined>;
    fetch?: unknown;
    url?: (options: { path: string }) => string;
  };
}

function inspect(model: unknown): InspectableModel {
  return model as InspectableModel;
}

const anthropicEntry = ProviderEntrySchema.parse({
  id: "anthropic",
  name: "Anthropic",
  env: ["ANTHROPIC_API_KEY"],
  npm: "@ai-sdk/anthropic",
  models: {},
});

describe("createLanguageModel", () => {
  it("constructs an anthropic model from an api credential", () => {
    const model = inspect(
      createLanguageModel({
        provider: anthropicEntry,
        modelId: "claude-test",
        credential: { type: "api", key: "sk-ant-test" },
        env: {},
      }),
    );
    expect(model.modelId).toBe("claude-test");
    expect(model.provider).toBe("anthropic.messages");
    expect(model.config.headers()["x-api-key"]).toBe("sk-ant-test");
  });

  it("falls back to the provider env var, then to the unconfigured placeholder", () => {
    const fromEnv = inspect(
      createLanguageModel({
        provider: anthropicEntry,
        modelId: "claude-test",
        env: { ANTHROPIC_API_KEY: "sk-ant-env" },
      }),
    );
    expect(fromEnv.config.headers()["x-api-key"]).toBe("sk-ant-env");

    const unconfigured = inspect(
      createLanguageModel({ provider: anthropicEntry, modelId: "claude-test", env: {} }),
    );
    expect(unconfigured.config.headers()["x-api-key"]).toBe("clankie-unconfigured");
  });

  it("routes explicit baseURL through the openai-compatible factory", () => {
    const ollamaEntry = ProviderEntrySchema.parse({ id: "ollama", name: "Ollama", models: {} });
    const model = inspect(
      createLanguageModel({
        provider: ollamaEntry,
        modelId: "llama-test",
        baseURL: "http://localhost:11434/v1",
        env: {},
      }),
    );
    expect(model.modelId).toBe("llama-test");
    expect(model.provider).toBe("ollama.chat");
    expect(must(model.config.url)({ path: "/chat/completions" })).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
    const headers = model.config.headers();
    expect(headers["Authorization"] ?? headers["authorization"]).toBe("Bearer clankie-unconfigured");
  });

  it("uses the oauth placeholder key and passes fetchImpl through", () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network access is forbidden in this test");
    };
    const model = inspect(
      createLanguageModel({
        provider: anthropicEntry,
        modelId: "claude-test",
        credential: { type: "oauth", access: "at", refresh: "rt", expires: 0 },
        fetchImpl,
        env: {},
      }),
    );
    expect(model.config.fetch).toBe(fetchImpl);
    expect(model.config.headers()["x-api-key"]).toBe("clankie-oauth");
  });
});

describe("providerFamilyFor", () => {
  it("maps ids/npm packages to families and defaults to openai-compatible", () => {
    expect(providerFamilyFor({ id: "anthropic" })).toBe("anthropic");
    expect(providerFamilyFor({ id: "openai-codex" })).toBe("openai");
    expect(providerFamilyFor({ id: "custom", npm: "@ai-sdk/google" })).toBe("google");
    expect(providerFamilyFor({ id: "xai" })).toBe("xai");
    expect(providerFamilyFor({ id: "fireworks" })).toBe("openai-compatible");
    // Explicit baseURL always routes through the compatible factory.
    expect(providerFamilyFor({ id: "anthropic" }, "http://proxy:8080/v1")).toBe("openai-compatible");
  });
});

describe("variantProviderOptions", () => {
  it("returns empty options for undefined variants", () => {
    expect(variantProviderOptions(undefined, "anthropic")).toEqual({});
  });

  it("camelizes anthropic thinking budgets into the anthropic namespace", () => {
    const options = variantProviderOptions(
      { id: "think-8k", body: { thinking: { type: "enabled", budget_tokens: 8_000 } } },
      "anthropic",
    );
    expect(options.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8_000 } },
    });
    expect(options.headers).toBeUndefined();
  });

  it("camelizes reasoning_effort for openai, xai, and openai-compatible namespaces", () => {
    expect(
      variantProviderOptions({ id: "low", body: { reasoning_effort: "low" } }, "openai").providerOptions,
    ).toEqual({ openai: { reasoningEffort: "low" } });
    expect(
      variantProviderOptions({ id: "high", body: { reasoning_effort: "high" } }, "xai").providerOptions,
    ).toEqual({ xai: { reasoningEffort: "high" } });
    expect(
      variantProviderOptions({ id: "low", body: { reasoning_effort: "low" } }, "openai-compatible")
        .providerOptions,
    ).toEqual({ openaiCompatible: { reasoningEffort: "low" } });
  });

  it("passes variant headers through", () => {
    const options = variantProviderOptions(
      { id: "custom", headers: { "x-clankie-variant": "custom" } },
      "openai",
    );
    expect(options.headers).toEqual({ "x-clankie-variant": "custom" });
    expect(options.providerOptions).toBeUndefined();
  });
});
