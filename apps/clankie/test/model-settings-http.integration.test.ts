import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { updateGlobalConfig, loadConfig } from "@clankie/model-provider";
import { ModelSettingsResponseSchema } from "@clankie/protocol/model-keys";
import { expect, it } from "vitest";
import { createModelKeys } from "../src/model-keys.ts";
import { createModelKeyRoutes } from "../src/model-key-routes.ts";
import { readModelSettings, modelSet } from "../../tui/src/command/model.ts";

it("serves one authenticated settings contract, persists selection and reversal, and rejects unavailable choices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-settings-http-"));
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: dir,
    CLANKIE_OPERATOR_TOKEN: "owner",
    CLANKIE_DISABLE_MODELS_FETCH: "1",
    CLANKIE_MODELS_PATH: join(dir, "catalog.json"),
  };
  await writeFile(env.CLANKIE_MODELS_PATH!, "{}");
  await updateGlobalConfig(
    (config) => {
      config.enabled_providers = ["fixture"];
      config.model = "fixture/first";
      config.provider = {
        fixture: {
          name: "Fixture Provider",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:1/v1" },
          models: {
            first: { name: "First", limit: { context: 32000, output: 512 } },
            second: { name: "Second", limit: { context: 32000, output: 512 } },
          },
        },
      };
    },
    { env },
  );
  const models = createModelKeys({
    env,
    cwd: dir,
    store: new FileCredentialStore(join(dir, "credentials.json")),
  });
  const app = createModelKeyRoutes(models, async (request) =>
    request.headers.get("authorization") === "Bearer owner" ? true : "authentication_required",
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const host = `http://127.0.0.1:${address.port}`;
  const request = (model?: string, auth = true) =>
    fetch(`${host}/v1/model-settings`, {
      method: model === undefined ? "GET" : "POST",
      headers: { ...(auth ? { authorization: "Bearer owner" } : {}), "content-type": "application/json" },
      ...(model === undefined ? {} : { body: JSON.stringify({ model }) }),
    });
  try {
    const first = await readModelSettings({ env, host });
    expect(first.selected).toBe("fixture/first");
    expect(first.effective?.actual).toEqual({
      providerId: "fixture",
      providerName: "Fixture Provider",
      modelId: "first",
      modelName: "First",
    });
    expect(first.choices.map((entry) => entry.ref)).toEqual(["fixture/first", "fixture/second"]);
    expect(first.choices.every((entry) => entry.available && entry.funding === "own_provider")).toBe(true);
    expect(ModelSettingsResponseSchema.parse(await (await request()).json())).toEqual(first);
    await modelSet("fixture/second", { env, host });
    expect((await readModelSettings({ env, host })).effective?.actual?.modelId).toBe("second");
    expect((await loadConfig({ env })).config.model).toBe("fixture/second");
    expect((await request("fixture/missing")).status).toBe(400);
    expect((await request("clankie/escalation")).status).toBe(400);
    expect((await request("fixture/first", false)).status).toBe(401);
    expect((await loadConfig({ env })).config.model).toBe("fixture/second");
    await modelSet("fixture/first", { env, host });
    expect(await readModelSettings({ env, host })).toEqual(first);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

it("reads hosted settings and options without probing policy-refused subscription credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-model-settings-http-"));
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: dir,
    CLANKIE_DISABLE_MODELS_FETCH: "1",
    CLANKIE_HOSTED_BOOTSTRAP_FILE: join(dir, "bootstrap.json"),
  };
  const store = new FileCredentialStore(join(dir, "credentials.json"));
  const blocked = { type: "oauth" as const, access: "fixture-old", refresh: "fixture-refresh", expires: 1 };
  await store.set("openai-codex", blocked);
  await store.set("anthropic", blocked);
  await updateGlobalConfig(
    (config) => {
      config.model = "clankie/default";
      config.provider = {
        clankie: {
          name: "Clankie (included)",
          npm: "@ai-sdk/openai",
          options: { baseURL: "http://127.0.0.1:1/v1" },
          models: { default: { name: "Clankie default", limit: { context: 32000, output: 512 } } },
        },
      };
    },
    { env },
  );
  const models = createModelKeys({
    env,
    cwd: dir,
    store,
    includedMappings: async () => ({
      mappings: [
        {
          ref: "clankie/default",
          actual: {
            providerId: "openai",
            providerName: "OpenAI",
            modelId: "fixture-model",
            modelName: "Fixture model",
          },
          available: true,
          reason: null,
        },
      ],
    }),
  });
  const app = createModelKeyRoutes(models, async (request) =>
    request.headers.get("authorization") === "Bearer owner" ? true : "authentication_required",
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/v1/model-settings`, {
      headers: { authorization: "Bearer owner" },
    });
    expect(response.status).toBe(200);
    const settings = ModelSettingsResponseSchema.parse(await response.json());
    expect(settings.effective).toMatchObject({
      ref: "clankie/default",
      funding: "included",
      available: true,
      actual: { modelId: "fixture-model" },
    });
    expect(
      settings.choices.some(
        (entry) => entry.ref.startsWith("openai-codex/") || entry.ref.startsWith("anthropic/"),
      ),
    ).toBe(false);
    const options = await fetch(`${origin}/v1/model-keys/options`, {
      headers: { authorization: "Bearer owner" },
    });
    expect(options.status).toBe(200);
    expect((await options.json()).usableProviders).toContain("clankie");
    expect(await models.select("openai-codex/gpt-6-luna")).toEqual({ ok: false, error: "unsupported_model" });
    expect((await fetch(`${origin}/v1/model-settings`)).status).toBe(401);
    expect(await store.get("openai-codex")).toEqual(blocked);
    expect(await store.get("anthropic")).toEqual(blocked);
    expect((await loadConfig({ env })).config.model).toBe("clankie/default");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

it("migrates legacy tier writes through the shared eligible choice and refuses unavailable included mappings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-alias-http-"));
  const env = {
    XDG_CONFIG_HOME: dir,
    CLANKIE_DISABLE_MODELS_FETCH: "1",
    CLANKIE_HOSTED_BOOTSTRAP_FILE: join(dir, "bootstrap.json"),
  };
  await updateGlobalConfig(
    (config) => {
      config.enabled_providers = ["clankie"];
      config.model = "clankie/routine";
      config.provider = {
        clankie: {
          name: "Included",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:1/v1" },
          models: Object.fromEntries(
            ["default", "routine", "escalation"].map((id) => [
              id,
              { name: id, limit: { context: 32000, output: 512 } },
            ]),
          ),
        },
      };
    },
    { env },
  );
  let available = true;
  const models = createModelKeys({
    env,
    cwd: dir,
    store: new FileCredentialStore(join(dir, "keys.json")),
    includedMappings: async () => ({
      mappings: ["default", "routine", "escalation"].map((id) => ({
        ref: `clankie/${id}`,
        actual: { providerId: "openai", providerName: "OpenAI", modelId: "fixture", modelName: "Fixture" },
        available,
        reason: available ? null : "plan_unavailable",
      })),
    }),
  });
  const app = createModelKeyRoutes(models, async (request) =>
    request.headers.get("authorization") === "Bearer owner" ? true : "forbidden",
  );
  const select = (path: string, model: string, auth = true) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer owner" } : {}) },
      body: JSON.stringify({ model }),
    });
  try {
    expect((await models.settings!()).selected).toBe("clankie/routine");
    expect((await models.settings!()).choices.map((c) => c.ref)).toEqual(["clankie/default"]);
    expect((await select("/v1/model-settings", "clankie/escalation")).status).toBe(400);
    expect(await (await select("/v1/model-keys/select", "clankie/escalation")).json()).toEqual({ ok: true });
    expect((await loadConfig({ env })).config.model).toBe("clankie/default");
    available = false;
    for (const model of ["clankie/default", "clankie/routine", "clankie/escalation"]) {
      expect(await (await select("/v1/model-keys/select", model)).json()).toEqual({
        ok: false,
        error: "unsupported_model",
      });
    }
    expect((await select("/v1/model-keys/select", "clankie/default", false)).status).toBe(403);
    expect((await loadConfig({ env })).config.model).toBe("clankie/default");
  } finally {
    models.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});
