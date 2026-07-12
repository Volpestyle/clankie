import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, ProviderCredential, RedactedCredential } from "@clankie/credential-broker";
import { CatalogSchema } from "@clankie/model-registry";
import { generateText } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { ANTHROPIC_OAUTH_BETA_FEATURES, resolveConfiguredLanguageModel } from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-test": {
        id: "claude-test",
        name: "Claude Test",
        reasoning: true,
        tool_call: true,
        limit: { context: 200_000, output: 32_000 },
      },
    },
  },
});

async function configEnvironment(): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const cwd = await mkdtemp(join(tmpdir(), "anthropic-configured-model-"));
  tempDirs.push(cwd);
  const configDir = join(cwd, "config", "clankie");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "clankie.json"),
    `${JSON.stringify({ model: "anthropic/claude-test" })}\n`,
    "utf8",
  );
  return { cwd, env: { XDG_CONFIG_HOME: join(cwd, "config") } };
}

function anthropicResponse(text: string): Response {
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 2 },
  });
}

describe("configured Anthropic captain models", () => {
  it("uses the brokered Pro/Max credential for a headless captain turn", async () => {
    const { cwd, env } = await configEnvironment();
    const store = new MemoryCredentialStore({
      anthropic: {
        type: "oauth",
        access: "subscription-access",
        refresh: "subscription-refresh",
        expires: Date.now() + 60_000,
      },
    });
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    let capturedBody = "";
    const configured = await resolveConfiguredLanguageModel({
      cwd,
      env,
      catalog,
      store,
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = String(init?.body);
        return anthropicResponse("subscription works");
      },
    });

    const result = await generateText({ model: configured.model, prompt: "Say it works." });

    expect(result.text).toBe("subscription works");
    expect(configured.ref).toBe("anthropic/claude-test");
    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedHeaders.get("authorization")).toBe("Bearer subscription-access");
    expect(capturedHeaders.get("x-api-key")).toBeNull();
    const features = capturedHeaders.get("anthropic-beta")?.split(",") ?? [];
    for (const feature of ANTHROPIC_OAUTH_BETA_FEATURES) expect(features).toContain(feature);
    expect(capturedBody).not.toContain("subscription-access");
    expect(capturedBody).not.toContain("subscription-refresh");
  });

  it("keeps Anthropic API keys on the normal AI SDK path", async () => {
    const { cwd, env } = await configEnvironment();
    const store = new MemoryCredentialStore({
      anthropic: { type: "api", key: "anthropic-api-secret" },
    });
    let capturedHeaders = new Headers();
    const configured = await resolveConfiguredLanguageModel({
      cwd,
      env,
      catalog,
      store,
      fetchImpl: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return anthropicResponse("api key works");
      },
    });

    const result = await generateText({ model: configured.model, prompt: "Use the API key." });

    expect(result.text).toBe("api key works");
    expect(capturedHeaders.get("x-api-key")).toBe("anthropic-api-secret");
    expect(capturedHeaders.get("authorization")).toBeNull();
    const features = capturedHeaders.get("anthropic-beta")?.split(",") ?? [];
    expect(features).not.toContain("oauth-2025-04-20");
    expect(features).not.toContain("claude-code-20250219");
  });
});
