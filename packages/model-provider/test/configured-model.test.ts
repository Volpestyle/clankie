import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, ProviderCredential, RedactedCredential } from "@clankie/credential-broker";
import { CatalogSchema } from "@clankie/model-registry";
import { generateText } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfiguredModelError,
  resolveConfiguredLanguageModel,
  withCodexSubscriptionProvider,
} from "../src/index.ts";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

const tempDirs: string[] = [];

class MemoryCredentialStore implements CredentialStore {
  private readonly values: Record<string, ProviderCredential>;
  public constructor(values: Record<string, ProviderCredential>) {
    this.values = values;
  }
  public get(providerId: string): Promise<ProviderCredential | undefined> {
    return Promise.resolve(this.values[providerId]);
  }
  public set(providerId: string, credential: ProviderCredential): Promise<void> {
    this.values[providerId] = credential;
    return Promise.resolve();
  }
  public delete(providerId: string): Promise<boolean> {
    const found = this.values[providerId] !== undefined;
    delete this.values[providerId];
    return Promise.resolve(found);
  }
  public list(): Promise<Record<string, RedactedCredential>> {
    return Promise.resolve({});
  }
}

const catalog = CatalogSchema.parse({
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: {
      "gpt-5.5": {
        id: "gpt-5.5",
        name: "GPT 5.5",
        reasoning: true,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT 5.4",
        reasoning: true,
        limit: { context: 200_000, output: 32_000 },
      },
      "gpt-5.6": {
        id: "gpt-5.6",
        name: "GPT 5.6",
        reasoning: true,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-5.6-sol": {
        id: "gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        reasoning: true,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-6-astra": {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        reasoning: true,
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-5.6-luna": {
        id: "gpt-5.6-luna",
        name: "GPT 5.6 Luna",
        reasoning: true,
        limit: { context: 300_000, output: 64_000 },
      },
      "gpt-5.6-pro": {
        id: "gpt-5.6-pro",
        name: "GPT 5.6 Pro",
        reasoning: true,
        limit: { context: 300_000, output: 64_000 },
      },
    },
  },
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function must<T>(value: T | undefined, label = "value"): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

function codexCredential(): ProviderCredential {
  return {
    type: "oauth",
    access: "access-secret",
    refresh: "refresh-secret",
    expires: Date.now() + 60_000,
    accountId: "acct-test",
  };
}

/** Minimal Responses reply, recording each request so tests can assert the transport. */
function recordingCodexFetch(calls: { url: string; body: Record<string, unknown> }[]): typeof fetch {
  return (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Promise.resolve(
      Response.json({
        id: "resp_test",
        object: "response",
        created_at: 1,
        model: "gpt-5.5",
        output: [
          {
            id: "msg_test",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "live", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }),
    );
  };
}

async function configEnv(config: unknown): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "configured-model-"));
  tempDirs.push(root);
  const configDir = join(root, "clankie");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "clankie.json"), `${JSON.stringify(config)}\n`, "utf8");
  return { XDG_CONFIG_HOME: root };
}

describe("withCodexSubscriptionProvider", () => {
  it("adds only verified subscription models beside the OpenAI API catalog", () => {
    const result = withCodexSubscriptionProvider(catalog);
    expect(result.openai?.models["gpt-5.6-luna"]).toBeDefined();
    expect(result["openai-codex"]?.models["gpt-5.6-luna"]).toBeDefined();
    expect(result["openai-codex"]?.models["gpt-5.5"]?.cost).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    });
    expect(result["openai-codex"]?.models["gpt-6-astra"]).toBeDefined();
    expect(result["openai-codex"]?.models["gpt-5.6-pro"]).toBeUndefined();
    // Dropped from the verified list after the backend refused it at every
    // effort; the metered OpenAI key still serves it.
    expect(result.openai?.models["gpt-5.4"]).toBeDefined();
    expect(result["openai-codex"]?.models["gpt-5.4"]).toBeUndefined();
    expect(result.openai?.env).toEqual(["OPENAI_API_KEY"]);
    expect(result["openai-codex"]?.env).toEqual([]);
  });

  it("states the Codex backend window instead of the API-key window", () => {
    const result = withCodexSubscriptionProvider(catalog);
    const backendLimit = { context: 400_000, input: 272_000, output: 128_000 };
    expect(result["openai-codex"]?.models["gpt-5.6-luna"]?.limit).toEqual(backendLimit);
    expect(result["openai-codex"]?.models["gpt-6-astra"]?.limit).toEqual(backendLimit);
    expect(result.openai?.models["gpt-5.6-luna"]?.limit).toEqual({
      context: 300_000,
      output: 64_000,
    });
  });
});

describe("resolveConfiguredLanguageModel", () => {
  it("uses the exact Codex credential and forces the Responses request contract", async () => {
    const env = await configEnv({
      model: "openai-codex/gpt-5.5",
      variant: { "openai-codex/gpt-5.5": "low" },
    });
    const store = new MemoryCredentialStore({
      "openai-codex": {
        type: "oauth",
        access: "access-secret",
        refresh: "refresh-secret",
        expires: Date.now() + 60_000,
        accountId: "acct-test",
      },
    });
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "resp_test",
        object: "response",
        created_at: 1,
        model: "gpt-5.5",
        output: [
          {
            id: "msg_test",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "live", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      });
    };
    const configured = await resolveConfiguredLanguageModel({
      env,
      cwd: tempDirs[0] as string,
      catalog,
      store,
      sessionId: "session-safe-id",
      fetchImpl,
    });
    const result = await generateText({
      model: configured.model,
      prompt: "say live",
      ...configured.modelOptions,
    });

    expect(result.text).toBe("live");
    expect(configured.ref).toBe("openai-codex/gpt-5.5");
    expect(configured.modelContextWindowTokens).toBe(400_000);
    expect(configured.modelMaxOutputTokens).toBe(128_000);
    expect(capturedUrl).toBe(CODEX_API_ENDPOINT);
    expect(capturedHeaders.get("authorization")).toBe("Bearer access-secret");
    expect(capturedHeaders.get("chatgpt-account-id")).toBe("acct-test");
    expect(capturedHeaders.get("session-id")).toBe("session-safe-id");
    expect(capturedBody.store).toBe(false);
    expect(capturedBody.instructions).toEqual(expect.any(String));
    expect(String(capturedBody.instructions).length).toBeGreaterThan(0);
    expect(capturedBody.reasoning).toMatchObject({ effort: "low" });
    expect(JSON.stringify(capturedBody)).not.toContain("access-secret");
    expect(JSON.stringify(capturedBody)).not.toContain("refresh-secret");
  });

  it("sends Astra's effort on the wire, forcing reasoning past the SDK's model-id gate", async () => {
    const env = await configEnv({
      model: "openai-codex/gpt-6-astra",
      variant: { "openai-codex/gpt-6-astra": "max" },
    });
    const store = new MemoryCredentialStore({ "openai-codex": codexCredential() });
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const configured = await resolveConfiguredLanguageModel({
      env,
      cwd: tempDirs[0] as string,
      catalog,
      store,
      fetchImpl: recordingCodexFetch(calls),
    });
    await generateText({ model: configured.model, prompt: "say live", ...configured.modelOptions });

    // Without forceReasoning, @ai-sdk/openai drops the effort for any id
    // outside its `o*`/`gpt-5` prefix list and the turn runs at the default.
    expect(must(calls[0]).body.reasoning).toMatchObject({ effort: "max" });
  });

  it("refuses an effort Astra has no tier for instead of silently dropping it", async () => {
    for (const effort of ["none", "minimal"]) {
      const env = await configEnv({
        model: "openai-codex/gpt-6-astra",
        variant: { "openai-codex/gpt-6-astra": effort },
      });
      const store = new MemoryCredentialStore({ "openai-codex": codexCredential() });
      await expect(
        resolveConfiguredLanguageModel({ env, cwd: tempDirs[0] as string, catalog, store }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<ConfiguredModelError>>({
          name: "ConfiguredModelError",
          message: expect.stringContaining(
            `Model variant "${effort}" is not supported by openai-codex/gpt-6-astra; ` +
              "it accepts low, medium, high, xhigh, max",
          ),
        }),
      );
    }
  });

  it("still reads `off` as no thinking options where the ladder is token budgets", async () => {
    const env = await configEnv({
      model: "anthropic/claude-test",
      variant: { "anthropic/claude-test": "off" },
      provider: { anthropic: { models: { "claude-test": { reasoning: true } } } },
    });
    const store = new MemoryCredentialStore({ anthropic: { type: "api", key: "sk-anthropic" } });
    const configured = await resolveConfiguredLanguageModel({
      env,
      cwd: tempDirs[0] as string,
      catalog,
      store,
    });
    expect(configured.modelOptions).toBeUndefined();
  });

  it("never borrows the Codex credential for a model the subscription cannot serve", async () => {
    const env = await configEnv({ model: "openai/gpt-5.6-pro" });
    const store = new MemoryCredentialStore({ "openai-codex": codexCredential() });
    await expect(
      resolveConfiguredLanguageModel({ env, cwd: tempDirs[0] as string, catalog, store }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ConfiguredModelError>>({
        name: "ConfiguredModelError",
        message: expect.stringContaining("No credential is configured for openai"),
      }),
    );
  });
});

describe("subscription precedence", () => {
  it("routes an API-key ref through the subscription and keeps the configured effort", async () => {
    const env = await configEnv({
      model: "openai/gpt-5.5",
      variant: { "openai/gpt-5.5": "xhigh" },
    });
    const store = new MemoryCredentialStore({ "openai-codex": codexCredential() });
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const configured = await resolveConfiguredLanguageModel({
      env: { ...env, OPENAI_API_KEY: "sk-metered" },
      cwd: tempDirs[0] as string,
      catalog,
      store,
      fetchImpl: recordingCodexFetch(calls),
    });
    const result = await generateText({
      model: configured.model,
      prompt: "say live",
      ...configured.modelOptions,
    });

    expect(result.text).toBe("live");
    expect(configured.ref).toBe("openai-codex/gpt-5.5");
    // The Codex backend window, not the 1.05M API-key window the ref named.
    expect(configured.modelContextWindowTokens).toBe(400_000);
    expect(must(calls[0]).url).toBe(CODEX_API_ENDPOINT);
    expect(must(calls[0]).body.reasoning).toMatchObject({ effort: "xhigh" });
    expect(JSON.stringify(calls)).not.toContain("sk-metered");
  });

  it("resolves the bare gpt-5.6 alias to the size slug the backend answers", async () => {
    const env = await configEnv({ model: "openai/gpt-5.6" });
    const store = new MemoryCredentialStore({ "openai-codex": codexCredential() });
    const configured = await resolveConfiguredLanguageModel({
      env,
      cwd: tempDirs[0] as string,
      catalog,
      store,
      fetchImpl: recordingCodexFetch([]),
    });
    expect(configured.ref).toBe("openai-codex/gpt-5.6-sol");
  });

  it("leaves the ref alone without a subscription credential", async () => {
    const env = await configEnv({ model: "openai/gpt-5.5" });
    const store = new MemoryCredentialStore({});
    const configured = await resolveConfiguredLanguageModel({
      env: { ...env, OPENAI_API_KEY: "sk-metered" },
      cwd: tempDirs[0] as string,
      catalog,
      store,
    });
    expect(configured.ref).toBe("openai/gpt-5.5");
    expect(configured.modelContextWindowTokens).toBe(1_050_000);
  });

  it("honors disabling the subscription provider as the explicit metered opt-out", async () => {
    const env = await configEnv({ model: "openai/gpt-5.5", disabled_providers: ["openai-codex"] });
    const store = new MemoryCredentialStore({ "openai-codex": codexCredential() });
    const configured = await resolveConfiguredLanguageModel({
      env: { ...env, OPENAI_API_KEY: "sk-metered" },
      cwd: tempDirs[0] as string,
      catalog,
      store,
    });
    expect(configured.ref).toBe("openai/gpt-5.5");
  });
});
