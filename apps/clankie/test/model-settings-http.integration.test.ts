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
