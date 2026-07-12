import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, ProviderCredential, RedactedCredential } from "@clankie/credential-broker";
import { CatalogSchema } from "@clankie/model-registry";
import { generateText } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_API_ENDPOINT,
  ConfiguredModelError,
  resolveConfiguredLanguageModel,
  withCodexSubscriptionProvider,
} from "../src/index.ts";

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
    expect(result["openai-codex"]?.models["gpt-5.5"]?.cost).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    });
    expect(result["openai-codex"]?.models["gpt-5.6-luna"]).toBeUndefined();
    expect(result["openai-codex"]?.models["gpt-5.6-pro"]).toBeUndefined();
    expect(result.openai?.env).toEqual(["OPENAI_API_KEY"]);
    expect(result["openai-codex"]?.env).toEqual([]);
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

  it("never borrows the Codex credential for an OpenAI model ref", async () => {
    const env = await configEnv({ model: "openai/gpt-5.6-luna" });
    const store = new MemoryCredentialStore({
      "openai-codex": {
        type: "oauth",
        access: "access-secret",
        refresh: "refresh-secret",
        expires: Date.now() + 60_000,
      },
    });
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
