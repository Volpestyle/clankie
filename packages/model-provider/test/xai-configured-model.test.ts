import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, ProviderCredential, RedactedCredential } from "@clankie/credential-broker";
import { CatalogSchema } from "@clankie/model-registry";
import { generateText } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfiguredLanguageModel } from "../src/index.ts";

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
  xai: {
    id: "xai",
    name: "xAI",
    env: ["XAI_API_KEY"],
    npm: "@ai-sdk/xai",
    models: {
      "grok-test": {
        id: "grok-test",
        name: "Grok Test",
        reasoning: true,
        tool_call: true,
        limit: { context: 128_000, output: 16_000 },
      },
    },
  },
});

async function configEnvironment(): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const cwd = await mkdtemp(join(tmpdir(), "xai-configured-model-"));
  tempDirs.push(cwd);
  const configDir = join(cwd, "config", "clankie");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "clankie.json"), `${JSON.stringify({ model: "xai/grok-test" })}\n`, "utf8");
  return { cwd, env: { XDG_CONFIG_HOME: join(cwd, "config") } };
}

function xaiResponse(text: string): Response {
  return Response.json({
    id: "resp_test",
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_test",
        role: "assistant",
        content: [{ type: "output_text", text }],
        status: "completed",
      },
    ],
    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
  });
}

describe("configured xAI captain models", () => {
  it("uses the brokered SuperGrok credential for a headless captain turn", async () => {
    const { cwd, env } = await configEnvironment();
    const store = new MemoryCredentialStore({
      xai: {
        type: "oauth",
        access: "subscription-access",
        refresh: "subscription-refresh",
        expires: Date.now() + 600_000,
      },
    });
    let capturedHeaders = new Headers();
    const configured = await resolveConfiguredLanguageModel({
      cwd,
      env,
      catalog,
      store,
      fetchImpl: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return xaiResponse("subscription works");
      },
    });

    const result = await generateText({ model: configured.model, prompt: "Say it works." });

    expect(result.text).toBe("subscription works");
    expect(configured.ref).toBe("xai/grok-test");
    expect(configured.modelOptions?.providerOptions).toEqual({ xai: { reasoningEffort: "medium" } });
    expect(capturedHeaders.get("authorization")).toBe("Bearer subscription-access");
  });

  it("keeps xAI API keys on the normal AI SDK path", async () => {
    const { cwd, env } = await configEnvironment();
    const store = new MemoryCredentialStore({
      xai: { type: "api", key: "xai-api-secret" },
    });
    let capturedHeaders = new Headers();
    const configured = await resolveConfiguredLanguageModel({
      cwd,
      env,
      catalog,
      store,
      fetchImpl: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return xaiResponse("api key works");
      },
    });

    const result = await generateText({ model: configured.model, prompt: "Use the API key." });

    expect(result.text).toBe("api key works");
    expect(capturedHeaders.get("authorization")).toBe("Bearer xai-api-secret");
  });
});
