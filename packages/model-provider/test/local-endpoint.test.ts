import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalConfigPath, loadConfig } from "../src/config.ts";
import {
  declareLocalProvider,
  localModelCatalogEntry,
  normalizeLocalBaseUrl,
  probeLocalModels,
  setCaptainModel,
  validateLocalBaseUrl,
  validateLocalProviderId,
} from "../src/local-endpoint.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigEnv(): Promise<{ env: NodeJS.ProcessEnv; globalPath: string }> {
  const xdg = await mkdtemp(join(tmpdir(), "local-endpoint-test-"));
  tempDirs.push(xdg);
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: xdg };
  return { env, globalPath: globalConfigPath(env) };
}

describe("local endpoint helpers", () => {
  it("rewrites a bare origin to /v1 and strips a trailing slash", () => {
    expect(normalizeLocalBaseUrl("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000/v1");
    expect(normalizeLocalBaseUrl("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000/v1");
    expect(normalizeLocalBaseUrl("http://127.0.0.1:8000/v1/")).toBe("http://127.0.0.1:8000/v1");
  });

  it("rejects empty provider ids and non-http URLs", () => {
    expect(validateLocalProviderId("ds4")).toBeUndefined();
    expect(validateLocalProviderId("DS4")).toBeUndefined();
    expect(validateLocalProviderId("ds4/flash")).toBeDefined();
    expect(validateLocalBaseUrl("not-a-url")).toBeDefined();
    expect(validateLocalBaseUrl("ftp://localhost/v1")).toBeDefined();
    expect(validateLocalBaseUrl("http://127.0.0.1:8000/v1")).toBeUndefined();
  });

  it("caps output tokens at 8192 for large context windows", () => {
    expect(localModelCatalogEntry(32_768)).toEqual({
      tool_call: true,
      limit: { context: 32_768, output: 8_192 },
    });
    expect(localModelCatalogEntry(8_192)).toEqual({
      tool_call: true,
      limit: { context: 8_192, output: 2_048 },
    });
  });

  it("probes OpenAI-shaped /models lists and keeps per-model context", async () => {
    const models = await probeLocalModels("http://127.0.0.1:8000", async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
      return Response.json({
        data: [{ id: "deepseek-v4-flash" }, { id: "gpt-oss:20b", max_context_length: 131_072 }],
      });
    });
    expect(models).toEqual([{ id: "deepseek-v4-flash" }, { id: "gpt-oss:20b", context: 131_072 }]);
  });
});

describe("declareLocalProvider / setCaptainModel", () => {
  it("writes a credential-less openai-compatible provider and can select it as captain", async () => {
    const { env, globalPath } = await makeConfigEnv();
    const declared = await declareLocalProvider({
      providerId: "DS4",
      baseURL: "http://127.0.0.1:8000",
      models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro", context: 32_768 }],
      env,
    });
    expect(declared.provider?.["ds4"]?.options).toEqual({ baseURL: "http://127.0.0.1:8000/v1" });
    expect(declared.provider?.["ds4"]?.npm).toBe("@ai-sdk/openai-compatible");
    expect(declared.provider?.["ds4"]?.models?.["deepseek-v4-flash"]).toEqual({
      tool_call: true,
      limit: { context: 32_768, output: 8_192 },
    });

    const next = await setCaptainModel("ds4/deepseek-v4-flash", { env });
    expect(next.model).toBe("ds4/deepseek-v4-flash");
    const loaded = await loadConfig({ env });
    expect(loaded.config.model).toBe("ds4/deepseek-v4-flash");
    expect(JSON.parse(await readFile(globalPath, "utf8")).provider.ds4.options.baseURL).toBe(
      "http://127.0.0.1:8000/v1",
    );
  });

  it("refuses an empty model list and a malformed captain ref", async () => {
    const { env } = await makeConfigEnv();
    await expect(
      declareLocalProvider({ providerId: "ds4", baseURL: "http://127.0.0.1:8000/v1", models: [], env }),
    ).rejects.toThrow(/No models given/);
    await expect(setCaptainModel("not-a-ref", { env })).rejects.toThrow(/Invalid model ref/);
  });
});
