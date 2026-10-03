import { MemoryCredentialStore } from "../../credential-broker/test/memory-store.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogSchema } from "@clankie/model-registry";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfiguredLanguageModel } from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

async function configEnvironment(effort?: string): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const cwd = await mkdtemp(join(tmpdir(), "anthropic-configured-model-"));
  tempDirs.push(cwd);
  const configDir = join(cwd, "config", "clankie");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "clankie.json"),
    `${JSON.stringify({
      model: "anthropic/claude-test",
      ...(effort === undefined ? {} : { variant: { "anthropic/claude-test": effort } }),
    })}\n`,
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
  it("lowers Pi's effort name to the provider-specific thinking budget", async () => {
    const { cwd, env } = await configEnvironment("medium");
    const configured = await resolveConfiguredLanguageModel({
      cwd,
      env,
      catalog,
      store: new MemoryCredentialStore({ anthropic: { type: "api", key: "test-key" } }),
    });

    expect(configured.modelOptions?.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16_000 } },
    });
  });

  it("refuses a legacy Pro/Max credential before any captain request", async () => {
    const { cwd, env } = await configEnvironment();
    const store = new MemoryCredentialStore({
      anthropic: {
        type: "oauth",
        access: "subscription-access",
        refresh: "subscription-refresh",
        expires: 1,
      },
    });
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(resolveConfiguredLanguageModel({ cwd, env, catalog, store, fetchImpl })).rejects.toThrow(
      "no longer supports Claude",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await store.get("anthropic"))?.type).toBe("oauth");
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

it("refuses a subscription-shaped key on a custom provider using the Anthropic transport", async () => {
  const { cwd, env } = await configEnvironment();
  await writeFile(
    join(env.XDG_CONFIG_HOME!, "clankie", "clankie.json"),
    JSON.stringify({
      model: "custom-claude/claude-test",
      provider: {
        "custom-claude": {
          npm: "@ai-sdk/anthropic",
          models: { "claude-test": { limit: { context: 200000, output: 32000 } } },
        },
      },
    }),
  );
  const fetchImpl = vi.fn<typeof fetch>();
  const store = new MemoryCredentialStore({ "custom-claude": { type: "api", key: "sk-ant-oat01-old" } });
  await expect(resolveConfiguredLanguageModel({ cwd, env, catalog, store, fetchImpl })).rejects.toThrow(
    "no longer supports Claude",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
  await store.set("custom-claude", { type: "api", key: "sk-ant-api03-owned" });
  expect((await resolveConfiguredLanguageModel({ cwd, env, catalog, store, fetchImpl })).providerId).toBe(
    "custom-claude",
  );
});
