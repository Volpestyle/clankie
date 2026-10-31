import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { updateGlobalConfig } from "@clankie/model-provider";
import { createModelKeys } from "../src/model-keys.ts";
import { createModelKeyRoutes } from "../src/model-key-routes.ts";
import { HarnessSignIns } from "../src/harness-logins.ts";
import { createHarnessLoginRoutes } from "../src/harness-login-routes.ts";

async function body() {
  const home = await mkdtemp(join(tmpdir(), "model-credentials-"));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    PATH: process.env.PATH,
    CLANKIE_DISABLE_MODELS_FETCH: "1",
    CLANKIE_MODELS_PATH: join(home, "catalog.json"),
  };
  await mkdir(env.CODEX_HOME!, { recursive: true });
  await writeFile(join(env.CODEX_HOME!, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  await writeFile(env.CLANKIE_MODELS_PATH!, "{}");
  await updateGlobalConfig(
    (config) => {
      config.model = "fixture/first";
      config.provider = {
        fixture: {
          name: "Fixture",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:1/v1" },
          models: { first: { name: "First", limit: { context: 32000, output: 512 } } },
        },
      };
    },
    { env },
  );
  const store = new FileCredentialStore(join(home, "credentials.json"));
  const credential = { type: "api" as const, key: "existing-fixture-key" };
  await store.set("fixture", credential);
  const models = createModelKeys({ env, cwd: home, store });
  const logins = new HarnessSignIns({ env });
  const authorize = async (request: Request) =>
    request.headers.get("authorization") === "Bearer owner"
      ? (true as const)
      : ("authentication_required" as const);
  const app = new Hono();
  app.route(
    "/",
    createHarnessLoginRoutes(logins, authorize, async () => "operator:fixture"),
  );
  app.route(
    "/",
    createModelKeyRoutes(models, authorize, {
      signInAuthority: async () => ({
        principal: "operator:fixture",
        commit: async (write) => {
          await write();
          return true;
        },
      }),
    }),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing address");
  const call = async (path: string, payload?: unknown, authenticated = true) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { authorization: "Bearer owner" } : {}),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    env,
    store,
    models,
    logins,
    credential,
    call,
    close: async () => {
      logins.close();
      models.close?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

it("HTTP accepts customer model keys and preserves selection", async () => {
  const f = await body();
  try {
    expect(await f.call("/v1/model-keys/set", { providerId: "fixture", apiKey: "replacement-key" })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await f.call("/v1/model-settings", { model: "fixture/first" })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await f.store.get("fixture")).toEqual({ type: "api", key: "replacement-key" });
  } finally {
    await f.close();
  }
});

// Explicit manual proof: requires an installed native Codex and vendor network access.
// It obtains a login link, then cancels; it never signs into an account or records codes.
it.runIf(process.env.VUH2576_NATIVE_LOGIN === "1")("HTTP starts the real Codex device login", async () => {
  const f = await body();
  try {
    const start = await f.call("/v1/harness-logins/start", { harness: "codex" });
    expect(start.status).toBe(200);
    const id = start.body.sessionId;
    expect(typeof id).toBe("string");
    let shown = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await f.call("/v1/harness-logins/status", { sessionId: id });
      if (result.body.url) {
        shown = true;
        break;
      }
      if (["failed", "expired"].includes(result.body.state))
        throw Error("native Codex login failed before showing authorization link");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(shown).toBe(true);
    expect((await f.call("/v1/harness-logins/cancel", { sessionId: id })).body.state).toBe("cancelled");
  } finally {
    await f.close();
  }
});
