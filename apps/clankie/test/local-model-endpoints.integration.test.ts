import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import * as modelProvider from "@clankie/model-provider";
import {
  declareLocalProvider,
  loadConfig,
  setCaptainModel,
  updateGlobalConfig,
} from "@clankie/model-provider";
import { SUPERVISE_GRANTS, TAKE_CONTROL_GRANTS } from "@clankie/protocol";
import {
  LocalEndpointAddResultSchema,
  LocalEndpointsResponseSchema,
  ModelOptionsResponseSchema,
  MODEL_LOCAL_ENDPOINTS_PATH,
  MODEL_LOCAL_ENDPOINT_ADD_PATH,
} from "@clankie/protocol/model-keys";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { publicGatewayTargetFor } from "@clankie/protocol/public-gateway";
import { runHeadlessCaptainCommand } from "../../tui/bin/headless-captain.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCaptainModelRuntime } from "../src/captain/model.ts";
import { createModelKeys, type LocalRuntimeAddress } from "../src/model-keys.ts";

// Real service routes, pairing, broker, config, Pi runtime and CLI, against stub
// local runtimes speaking the OpenAI-compatible wire over real HTTP. They prove
// our boundary, not that a given Ollama, LM Studio or vLLM build behaves this way.
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface StubRuntime {
  readonly baseURL: string;
  readonly requests: string[];
  completion: "answer" | "refuse" | "hold";
  list: readonly unknown[];
  /** Lets a held completion answer. */
  release(): void;
}

async function stubRuntime(list: readonly unknown[]): Promise<StubRuntime> {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain */
    }
    requests.push(`${req.method} ${req.url}`);
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: stub.list }));
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    if (stub.completion === "refuse") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":{"message":"model failed to load"}}');
      return;
    }
    if (stub.completion === "hold") await held;
    const chunk = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "stub",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${chunk({ role: "assistant", content: "OK" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const stub: StubRuntime = {
    baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    requests,
    completion: "answer",
    list,
    release,
  };
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        release();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return stub;
}

async function closedPort(): Promise<string> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/v1`;
}

async function redirectingRuntime(to: string): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(307, { location: to }).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

async function fixture(local: readonly LocalRuntimeAddress[], onModelChanged?: () => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "local-endpoints-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const env = {
    XDG_CONFIG_HOME: dir,
    CLANKIE_DISABLE_MODELS_FETCH: "1",
    CLANKIE_MODELS_PATH: join(dir, "catalog.json"),
    CLANKIE_CREDENTIALS_FILE: join(dir, "credentials.json"),
  };
  await writeFile(env.CLANKIE_MODELS_PATH, "{}");
  const models = createModelKeys({
    store: new FileCredentialStore(env.CLANKIE_CREDENTIALS_FILE),
    env,
    cwd: dir,
    localRuntimes: local,
    ...(onModelChanged === undefined ? {} : { onModelChanged }),
  });
  const operatorToken = "clankie_op_" + "a".repeat(43);
  const app = await createClankieApp({
    captain: createStubCaptain(),
    modelKeys: models,
    modelDeviceSetup: { platform: "darwin", hosted: false },
    eventLogPath: join(dir, "events.jsonl"),
    deviceSessionKey: randomBytes(32),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${operatorToken}`
        ? { operatorId: "owner" }
        : undefined,
  });
  const server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanup.push(async () => {
    await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const call = (path: string, body?: unknown, token = operatorToken) =>
    fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const pair = async (grants: typeof TAKE_CONTROL_GRANTS | typeof SUPERVISE_GRANTS) => {
    const offer = await (await call("/v1/pairing/offer", {})).json();
    const pending = await (
      await call("/v1/pairing/redeem", {
        offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
        device: { name: "Phone", platform: "ios" },
      })
    ).json();
    return (await (
      await call("/v1/pairing/complete", { completionToken: pending.completionToken, acceptedGrants: grants })
    ).json()) as { deviceId: string; deviceToken: string };
  };
  const cli = async (...args: string[]) => {
    let stdout = "";
    let stderr = "";
    const exit = await runHeadlessCaptainCommand(["model", "local", ...args], {
      repoRoot: dir,
      host: origin,
      env: { ...env, CLANKIE_OPERATOR_TOKEN: operatorToken },
      stdout: { write: (text: string) => void (stdout += text) },
      stderr: { write: (text: string) => void (stderr += text) },
    });
    return { exit, stdout, stderr };
  };
  const config = async () => (await loadConfig({ env, cwd: dir })).config;
  const configFile = join(dir, "clankie", "clankie.json");
  return { dir, env, call, pair, cli, config, configFile, operatorToken };
}

const add = (runtime: string, modelId: string) => ({ runtime, modelId });

describe("adding a local model from a device", () => {
  it("lists what answers, and one Take Control device call makes the model the next turn's model", async () => {
    const ollama = await stubRuntime([
      { id: "qwen3:8b", context_length: 40_960 },
      { id: "nomic-embed", context_length: 2_048 },
    ]);
    const lmStudio = await stubRuntime([{ id: "gemma-3" }]);
    const silent = await stubRuntime([]);
    const { call, pair, config } = await fixture([
      { id: "ollama", name: "Ollama", baseURL: ollama.baseURL },
      { id: "lm-studio", name: "LM Studio", baseURL: lmStudio.baseURL },
      { id: "vllm", name: "vLLM", baseURL: silent.baseURL },
    ]);
    const { deviceToken } = await pair(TAKE_CONTROL_GRANTS);

    const listed = await call(MODEL_LOCAL_ENDPOINTS_PATH, undefined, deviceToken);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(LocalEndpointsResponseSchema.parse(await listed.json())).toEqual({
      endpoints: [
        {
          runtime: "ollama",
          name: "Ollama",
          baseURL: ollama.baseURL,
          models: [
            { id: "qwen3:8b", context: 40_960 },
            { id: "nomic-embed", context: 2_048 },
          ],
        },
        {
          runtime: "lm-studio",
          name: "LM Studio",
          baseURL: lmStudio.baseURL,
          models: [{ id: "gemma-3", context: null }],
        },
      ],
    });
    expect((await config()).provider).toBeUndefined();

    expect(
      (await (await call("/v1/captain/readiness", undefined, deviceToken)).json()).ready,
      "a fresh install has no model",
    ).toBe(false);
    const added = await call(MODEL_LOCAL_ENDPOINT_ADD_PATH, add("ollama", "qwen3:8b"), deviceToken);
    expect(added.status).toBe(200);
    expect(LocalEndpointAddResultSchema.parse(await added.json())).toEqual({
      ok: true,
      model: "ollama/qwen3:8b",
    });
    expect(ollama.requests).toContain("POST /v1/chat/completions");

    const written = await config();
    expect(written.model).toBe("ollama/qwen3:8b");
    expect(written.provider?.ollama?.options?.baseURL).toBe(ollama.baseURL);
    expect(Object.keys(written.provider?.ollama?.models ?? {})).toEqual(["qwen3:8b", "nomic-embed"]);
    expect((await (await call("/v1/captain/readiness", undefined, deviceToken)).json()).ready).toBe(true);
    const options = ModelOptionsResponseSchema.parse(
      await (await call("/v1/model-keys/options", undefined, deviceToken)).json(),
    );
    expect(options.usableProviders).toContain("ollama");
    expect(options.effort?.model).toBe("ollama/qwen3:8b");
  });

  it("gives each default-id runtime a working Pi provider, and the CLI reaches the same routes", async () => {
    const lmStudio = await stubRuntime([{ id: "gemma-3" }]);
    const vllm = await stubRuntime([{ id: "org/llama-3" }]);
    const { cli, config } = await fixture([
      { id: "lm-studio", name: "LM Studio", baseURL: lmStudio.baseURL },
      { id: "vllm", name: "vLLM", baseURL: vllm.baseURL },
    ]);

    const listed = await cli();
    expect(listed.exit).toBe(0);
    const value = JSON.parse(listed.stdout);
    expect(value.ok).toBe(true);
    expect(value.endpoints.map((endpoint: { runtime: string }) => endpoint.runtime)).toEqual([
      "lm-studio",
      "vllm",
    ]);

    const first = await cli("use", "lm-studio", "gemma-3");
    expect(first.exit, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ ok: true, model: "lm-studio/gemma-3" });
    const second = await cli("use", "vllm", "org/llama-3");
    expect(second.exit, second.stderr).toBe(0);
    expect((await config()).model).toBe("vllm/org/llama-3");

    const refused = await cli("use", "vllm", "not-served");
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain("unsupported_model");
    await expect(cli("use", "vllm")).resolves.toMatchObject({ exit: 1 });
  });

  it("refuses anything but a named runtime, so a device cannot aim the service at a host", async () => {
    const target = await stubRuntime([{ id: "bait" }]);
    const ollama = await stubRuntime([{ id: "qwen3:8b" }]);
    const { call, pair, config } = await fixture([{ id: "ollama", name: "Ollama", baseURL: ollama.baseURL }]);
    const { deviceToken } = await pair(TAKE_CONTROL_GRANTS);
    for (const body of [
      { ...add("ollama", "qwen3:8b"), baseURL: target.baseURL },
      add(target.baseURL, "bait"),
      { baseURL: target.baseURL, modelId: "bait" },
      "not json",
    ]) {
      const response = await call(MODEL_LOCAL_ENDPOINT_ADD_PATH, body, deviceToken);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "malformed" });
    }
    const oversized = await call(
      MODEL_LOCAL_ENDPOINT_ADD_PATH,
      add("ollama", "x".repeat(17 * 1024)),
      deviceToken,
    );
    expect(oversized.status).toBe(413);
    expect(target.requests).toEqual([]);
    expect(ollama.requests).toEqual([]);
    expect((await config()).model).toBeUndefined();
  });

  it("is owner-only: Supervise, a revoked device and no bearer never probe or write", async () => {
    const ollama = await stubRuntime([{ id: "qwen3:8b" }]);
    const { call, pair, config } = await fixture([{ id: "ollama", name: "Ollama", baseURL: ollama.baseURL }]);
    const supervise = await pair(SUPERVISE_GRANTS);
    const revoked = await pair(TAKE_CONTROL_GRANTS);
    expect((await call(`/v1/devices/${revoked.deviceId}/revoke`, {})).ok).toBe(true);

    for (const [token, status] of [
      [supervise.deviceToken, 403],
      [revoked.deviceToken, 401],
      ["not-a-token", 401],
    ] as const) {
      expect((await call(MODEL_LOCAL_ENDPOINTS_PATH, undefined, token)).status).toBe(status);
      expect((await call(MODEL_LOCAL_ENDPOINT_ADD_PATH, add("ollama", "qwen3:8b"), token)).status).toBe(
        status,
      );
    }
    expect(ollama.requests).toEqual([]);
    expect((await config()).provider).toBeUndefined();
    expect(publicGatewayTargetFor("GET", MODEL_LOCAL_ENDPOINTS_PATH)).toBe("control");
    expect(publicGatewayTargetFor("POST", MODEL_LOCAL_ENDPOINT_ADD_PATH)).toBe("control");
    expect(publicGatewayTargetFor("POST", MODEL_LOCAL_ENDPOINTS_PATH)).toBeUndefined();
    expect(hostedOperatorAllows("GET", MODEL_LOCAL_ENDPOINTS_PATH)).toBe(true);
    expect(hostedOperatorAllows("POST", MODEL_LOCAL_ENDPOINT_ADD_PATH, "{}")).toBe(true);
  });

  it("writes nothing when the runtime, model or proof fails", async () => {
    const ollama = await stubRuntime([{ id: "qwen3:8b" }]);
    ollama.completion = "refuse";
    const { call, config, configFile } = await fixture([
      { id: "ollama", name: "Ollama", baseURL: ollama.baseURL },
      { id: "vllm", name: "vLLM", baseURL: await closedPort() },
    ]);
    const refusal = async (runtime: string, modelId: string) => {
      const response = await call(MODEL_LOCAL_ENDPOINT_ADD_PATH, add(runtime, modelId));
      return [response.status, (await response.json()).error];
    };
    expect(await refusal("vllm", "any")).toEqual([400, "endpoint_unavailable"]);
    expect(await refusal("lm-studio", "any")).toEqual([400, "unsupported_provider"]);
    expect(await refusal("ollama", "not-served")).toEqual([400, "unsupported_model"]);
    expect(await refusal("ollama", "qwen3:8b")).toEqual([400, "validation_failed"]);
    await expect(readFile(configFile, "utf8")).rejects.toThrow();
    expect((await config()).model).toBeUndefined();

    // The failed provider must not linger in the listing the shared runtime serves.
    const catalog = await (await call("/v1/model-keys")).json();
    expect(catalog.providers.map((provider: { id: string }) => provider.id)).not.toContain("ollama");
  });

  it("refuses a provider id that already means something else, and refreshes its own", async () => {
    const ollama = await stubRuntime([{ id: "qwen3:8b" }]);
    const vllm = await stubRuntime([{ id: "served" }]);
    const { call, env, config } = await fixture([
      { id: "ollama", name: "Ollama", baseURL: ollama.baseURL },
      { id: "vllm", name: "vLLM", baseURL: vllm.baseURL },
    ]);
    await updateGlobalConfig(
      (current) => {
        current.provider = {
          vllm: {
            name: "Owner's GPU box",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://10.0.0.8:8000/v1" },
            models: { big: { limit: { context: 8_000, output: 512 } } },
          },
        };
      },
      { env },
    );
    await declareLocalProvider({
      providerId: "ollama",
      baseURL: ollama.baseURL.replace("127.0.0.1", "localhost"),
      models: [{ id: "old-model" }],
      env,
    });
    const before = (await config()).provider?.vllm;

    const conflict = await call(MODEL_LOCAL_ENDPOINT_ADD_PATH, add("vllm", "served"));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ ok: false, error: "provider_conflict" });
    expect((await config()).provider?.vllm).toEqual(before);
    expect(vllm.requests).not.toContain("POST /v1/chat/completions");

    expect((await call(MODEL_LOCAL_ENDPOINT_ADD_PATH, add("ollama", "qwen3:8b"))).status).toBe(200);
    expect(Object.keys((await config()).provider?.ollama?.models ?? {})).toEqual(["qwen3:8b"]);
    expect((await config()).provider?.vllm).toEqual(before);
  });

  it("honours the owner's provider policy before touching the endpoint", async () => {
    const ollama = await stubRuntime([{ id: "qwen3:8b" }]);
    const { call, env, config } = await fixture([{ id: "ollama", name: "Ollama", baseURL: ollama.baseURL }]);
    await updateGlobalConfig((current) => void (current.disabled_providers = ["ollama"]), { env });
    const response = await call(MODEL_LOCAL_ENDPOINT_ADD_PATH, add("ollama", "qwen3:8b"));
    expect(await response.json()).toEqual({ ok: false, error: "unsupported_provider" });
    expect(ollama.requests).not.toContain("POST /v1/chat/completions");
    expect((await config()).provider).toBeUndefined();
  });

  it("drops a device revoked while the proof runs, before anything is written", async () => {
    const ollama = await stubRuntime([{ id: "qwen3:8b" }]);
    ollama.completion = "hold";
    const { call, pair, config } = await fixture([{ id: "ollama", name: "Ollama", baseURL: ollama.baseURL }]);
    const { deviceId, deviceToken } = await pair(TAKE_CONTROL_GRANTS);
    const pending = call(MODEL_LOCAL_ENDPOINT_ADD_PATH, add("ollama", "qwen3:8b"), deviceToken);
    await vi.waitFor(() => expect(ollama.requests).toContain("POST /v1/chat/completions"));
    expect((await call(`/v1/devices/${deviceId}/revoke`, {})).ok).toBe(true);
    ollama.release();
    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "forbidden" });
    expect((await config()).provider).toBeUndefined();
    expect((await config()).model).toBeUndefined();
  });
});

describe("a device revoked while its add commits", () => {
  it.each(["declaring", "selecting"])(
    "waits for both writes when the revoke arrives while %s",
    async (phase) => {
      const ollama = await stubRuntime([{ id: "qwen3:8b" }]);
      const order: string[] = [];
      let revoke = () => {};
      const { call, pair, config } = await fixture(
        [{ id: "ollama", name: "Ollama", baseURL: ollama.baseURL }],
        async () => {
          if (phase === "selecting") revoke();
          // Time for a revocation to land here if the lock did not hold it back.
          await new Promise((resolve) => setTimeout(resolve, 50));
          order.push("selected");
        },
      );
      const { deviceId, deviceToken } = await pair(TAKE_CONTROL_GRANTS);
      let revoked: Promise<Response> | undefined;
      revoke = () => {
        revoked = call(`/v1/devices/${deviceId}/revoke`, {}).then((response) => {
          order.push("revoked");
          return response;
        });
      };
      const declare = modelProvider.declareLocalProvider;
      const spy = vi.spyOn(modelProvider, "declareLocalProvider").mockImplementation(async (input) => {
        if (phase === "declaring") revoke();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const declared = await declare(input);
        order.push("declared");
        return declared;
      });
      cleanup.push(() => spy.mockRestore());

      const response = await call(MODEL_LOCAL_ENDPOINT_ADD_PATH, add("ollama", "qwen3:8b"), deviceToken);
      expect(response.status).toBe(200);
      expect((await revoked!).ok).toBe(true);
      expect(order).toEqual(["declared", "selected", "revoked"]);
      expect((await config()).model).toBe("ollama/qwen3:8b");
      expect((await call(MODEL_LOCAL_ENDPOINTS_PATH, undefined, deviceToken)).status).toBe(401);
    },
  );
});

describe("a default port that redirects", () => {
  it("cannot point discovery or an add at another address", async () => {
    const target = await stubRuntime([{ id: "bait" }]);
    const baseURL = await redirectingRuntime(`${target.baseURL}/models`);
    const { call, config } = await fixture([{ id: "ollama", name: "Ollama", baseURL }]);
    expect(await (await call(MODEL_LOCAL_ENDPOINTS_PATH)).json()).toEqual({ endpoints: [] });
    const refused = await call(MODEL_LOCAL_ENDPOINT_ADD_PATH, add("ollama", "bait"));
    expect(await refused.json()).toEqual({ ok: false, error: "endpoint_unavailable" });
    expect(target.requests).toEqual([]);
    expect((await config()).provider).toBeUndefined();
  });
});

describe("a runtime that lists honestly but redirects its completions", () => {
  it("fails the proof without reaching the other address", async () => {
    const target = await stubRuntime([{ id: "bait" }]);
    const server = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "bait" }] }));
        return;
      }
      response.writeHead(307, { location: `${target.baseURL}/chat/completions` }).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const { call, config } = await fixture([{ id: "ollama", name: "Ollama", baseURL }]);
    const response = await call(MODEL_LOCAL_ENDPOINT_ADD_PATH, add("ollama", "bait"));
    expect(await response.json()).toEqual({ ok: false, error: "validation_failed" });
    expect(target.requests).toEqual([]);
    expect((await config()).provider).toBeUndefined();
  });
});

describe("the running captain", () => {
  it("resolves an endpoint added after boot, with no restart", async () => {
    const ollama = await stubRuntime([{ id: "qwen3:8b" }]);
    const dir = await mkdtemp(join(tmpdir(), "local-captain-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    // Every path the captain derives from the process stays inside this directory.
    vi.stubEnv("XDG_CONFIG_HOME", dir);
    vi.stubEnv("CLANKIE_CREDENTIALS_FILE", join(dir, "credentials.json"));
    vi.stubEnv("CLANKIE_MODELS_PATH", join(dir, "catalog.json"));
    vi.stubEnv("CLANKIE_DISABLE_MODELS_FETCH", "1");
    await writeFile(join(dir, "catalog.json"), "{}");
    const captain = await createCaptainModelRuntime(dir);
    await expect(captain.resolveSelection()).rejects.toThrow();

    const models = createModelKeys({
      store: new FileCredentialStore(join(dir, "credentials.json")),
      cwd: dir,
      localRuntimes: [{ id: "ollama", name: "Ollama", baseURL: ollama.baseURL }],
    });
    const owner = {
      commit: async (operation: () => Promise<void>) => {
        await operation();
        return true;
      },
    };
    await expect(
      models.addLocalEndpoint!({ runtime: "ollama", modelId: "qwen3:8b" }, owner),
    ).resolves.toEqual({
      ok: true,
      model: "ollama/qwen3:8b",
    });
    const selection = await captain.resolveSelection();
    expect(selection.ref).toBe("ollama/qwen3:8b");
    expect(selection.model.baseUrl).toBe(ollama.baseURL);
  });

  it("leaves a repository's provider change waiting for a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-captain-repo-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    vi.stubEnv("XDG_CONFIG_HOME", dir);
    vi.stubEnv("CLANKIE_CREDENTIALS_FILE", join(dir, "credentials.json"));
    vi.stubEnv("CLANKIE_MODELS_PATH", join(dir, "catalog.json"));
    vi.stubEnv("CLANKIE_DISABLE_MODELS_FETCH", "1");
    await writeFile(join(dir, "catalog.json"), "{}");
    const repoConfig = (baseURL: string) =>
      writeFile(
        join(dir, ".clankie.json"),
        JSON.stringify({
          provider: {
            repo: {
              name: "Repo",
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL },
              models: { served: { limit: { context: 64_000, output: 512 } } },
            },
          },
        }),
      );
    const booted = "http://127.0.0.1:9/booted/v1";
    const edited = "http://127.0.0.1:9/edited/v1";
    await repoConfig(booted);
    await setCaptainModel("repo/served");
    const captain = await createCaptainModelRuntime(dir);
    expect((await captain.resolveSelection()).model.baseUrl).toBe(booted);

    await repoConfig(edited);
    expect((await captain.resolveSelection()).model.baseUrl).toBe(booted);

    // An owner change registers live, and must not carry the repository's edit in with it.
    const ollama = await stubRuntime([{ id: "qwen3:8b" }]);
    await declareLocalProvider({
      providerId: "ollama",
      baseURL: ollama.baseURL,
      models: [{ id: "qwen3:8b" }],
    });
    expect((await captain.resolveSelection()).model.baseUrl).toBe(booted);
    await setCaptainModel("ollama/qwen3:8b");
    expect((await captain.resolveSelection()).model.baseUrl).toBe(ollama.baseURL);
    await setCaptainModel("repo/served");
    expect((await captain.resolveSelection()).model.baseUrl).toBe(booted);

    const restarted = await createCaptainModelRuntime(dir);
    expect((await restarted.resolveSelection()).model.baseUrl).toBe(edited);
  });
});
