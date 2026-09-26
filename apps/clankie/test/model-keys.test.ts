import { BrokerCredentialStore } from "../src/captain/model.ts";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { loadConfig } from "@clankie/model-provider";
import { SUPERVISE_GRANTS, TAKE_CONTROL_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
import { ModelKeysResponseSchema } from "@clankie/protocol/model-keys";
import { bodyTelemetryFromEnv } from "@clankie/observability/body-telemetry";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModelKeys } from "../src/model-keys.ts";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const logs = vi.hoisted(() => [] as unknown[]);
const diagnosticText = (value: unknown) =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry instanceof Error
      ? { name: entry.name, message: entry.message, stack: entry.stack, cause: entry.cause }
      : entry,
  );

vi.mock("@clankie/observability", async (original) => ({
  ...(await original<typeof import("@clankie/observability")>()),
  createLogger: () =>
    Object.fromEntries(
      ["trace", "debug", "info", "warn", "error", "fatal"].map((level) => [
        level,
        (...args: unknown[]) => logs.push({ level, args }),
      ]),
    ),
}));
const dirs: string[] = [],
  apps: ClankieApp[] = [];
afterEach(async () => {
  apps.splice(0).forEach((app) => app.close());
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  logs.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup(options: { modelId?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "model-keys-"));
  dirs.push(dir);
  const env = {
    XDG_CONFIG_HOME: dir,
    CLANKIE_DISABLE_MODELS_FETCH: "1",
    CLANKIE_MODELS_PATH: join(dir, "catalog.json"),
  };
  await writeFile(env.CLANKIE_MODELS_PATH, "{}");
  const store = new FileCredentialStore(join(dir, "credentials.json"));
  const model = {
    id: options.modelId ?? "test/model",
    name: "Test",
    provider: "openai",
    api: "openai-responses",
    reasoning: false,
  };
  const complete = vi.fn(async () => ({ stopReason: "stop" }));
  const runtime = {
    getProviders: () => [
      { id: "openai", name: "OpenAI", auth: { apiKey: {} } },
      { id: "oauth-only", name: "OAuth", auth: {} },
      { id: "disabled", name: "Disabled", auth: { apiKey: {} } },
    ],
    getModels: (id: string) => (id === "openai" ? [model] : []),
    getModel: (provider: string, id: string) =>
      provider === "openai" && id === model.id ? model : undefined,
    registerProvider: vi.fn(),
    complete,
  } as unknown as ModelRuntime;
  await mkdir(join(dir, "clankie"));
  await writeFile(join(dir, "clankie/clankie.json"), JSON.stringify({ disabled_providers: ["disabled"] }));
  const telemetryDir = join(dir, "telemetry");
  vi.stubEnv("CLANKIE_BODY_TELEMETRY_DIR", telemetryDir);
  const telemetry = bodyTelemetryFromEnv({ CLANKIE_BODY_TELEMETRY_DIR: telemetryDir }, "service")!;
  telemetry.emit({ event: "body.boot", phase: "clankie-healthy" });
  const models = createModelKeys({ store, env, cwd: dir, runtime: async () => runtime, telemetry });
  const app = await createClankieApp({
    captain: createStubCaptain(),
    modelKeys: models,
    deviceSessionKey: randomBytes(32),
    eventLogPath: join(dir, "events.jsonl"),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer captain" ? { captainId: "captain" } : undefined,
  });
  apps.push(app);
  const call = (path: string, body?: unknown, token = "owner") =>
    app.app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const pair = async (acceptedGrants: DeviceGrantSet) => {
    const offer = await (await call("/v1/pairing/offer", {})).json();
    const pending = await (
      await call("/v1/pairing/redeem", {
        offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
        device: { name: "Phone", platform: "ios" },
      })
    ).json();
    const response = await call("/v1/pairing/complete", {
      completionToken: pending.completionToken,
      acceptedGrants,
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  return { dir, env, store, models, complete, runtime, app, call, pair, telemetryDir, telemetry };
}

describe("owner model keys", () => {
  it("emits only model-setting metadata through the real telemetry spool, including working-key validation", async () => {
    const { call, telemetryDir, complete, store, telemetry } = await setup({ modelId: "gpt-4.1-mini" });
    const marker = "sk-marker-never-in-model-telemetry";
    const emit = vi.spyOn(telemetry, "emit");
    await call("/v1/model-keys/set", { providerId: "openai", apiKey: marker });
    await call("/v1/model-keys/set", { providerId: "openai", apiKey: `${marker}-replacement` });
    await call("/v1/model-keys/validate", { providerId: "openai", modelId: "gpt-4.1-mini" });
    complete.mockRejectedValueOnce(new Error(marker));
    await call("/v1/model-keys/validate", { providerId: "openai", modelId: "gpt-4.1-mini" });
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    complete.mockRejectedValueOnce(new Error(marker));
    await call("/v1/model-keys/validate", { providerId: "openai", modelId: "gpt-4.1-mini" });
    timeout.mockRestore();
    await call("/v1/model-keys/select", { model: "openai/gpt-4.1-mini" });
    await call("/v1/model-keys/select", { model: "openai/gpt-4.1-mini" }); // no change
    await call("/v1/model-keys/remove", { providerId: "openai" });
    await call("/v1/model-keys/remove", { providerId: "openai" }); // no key to remove
    vi.spyOn(store, "set").mockRejectedValueOnce(new Error(marker));
    await call("/v1/model-keys/set", { providerId: "openai", apiKey: marker });
    const events = [
      { action: "key-set", result: "ok" },
      { action: "key-replaced", result: "ok" },
      { action: "key-validated", result: "ok" },
      { action: "key-validated", result: "validation_failed" },
      { action: "key-validated", result: "validation_timeout" },
      { action: "model-selected", result: "ok", modelId: "gpt-4.1-mini" },
      { action: "key-removed", result: "ok" },
      { action: "key-set", result: "unavailable" },
    ].map((event) => ({ event: "body.model", providerId: "openai", ...event }));
    expect(emit.mock.calls.map(([event]) => event)).toEqual(events);
    const written = (
      await Promise.all(
        (await readdir(telemetryDir)).map((file) => readFile(join(telemetryDir, file), "utf8")),
      )
    ).join("");
    expect(written).not.toContain(marker);
    expect(
      written
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.event === "body.model"),
    ).toEqual(events.map((event) => ({ ...event, v: 1, atMs: expect.any(Number) })));
  });

  it("omits custom or unrecognized ids, even from an owner-supplied catalog", async () => {
    const marker = "private-marker-pretending-to-be-a-model";
    const { call, telemetry, runtime, env } = await setup({ modelId: marker });
    const emit = vi.spyOn(telemetry, "emit");
    await call("/v1/model-keys/select", { model: `openai/${marker}` });
    await call("/v1/model-keys/select", { model: `openai/${marker}-missing` });
    vi.spyOn(runtime, "getProviders").mockReturnValue([
      ...runtime.getProviders(),
      { id: marker, name: marker, auth: { apiKey: {} } },
    ] as never);
    await writeFile(
      env.CLANKIE_MODELS_PATH,
      JSON.stringify({
        [marker]: { id: marker, name: marker, env: [], models: {} },
      }),
    );
    await call("/v1/model-keys/set", { providerId: marker, apiKey: "sk-secret-value" });
    await call("/v1/model-keys/set", { providerId: `${marker}-unknown`, apiKey: "sk-secret-value" });
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { event: "body.model", action: "model-selected", result: "ok", providerId: "openai" },
      { event: "body.model", action: "model-selected", result: "unsupported_model", providerId: "openai" },
      { event: "body.model", action: "key-set", result: "ok" },
      { event: "body.model", action: "key-set", result: "unsupported_provider" },
    ]);
    expect(diagnosticText(emit.mock.calls)).not.toContain(marker);
    expect(diagnosticText(emit.mock.calls)).not.toContain("sk-secret-value");
  });

  it("telemetry failure cannot break a successful key write", async () => {
    const { call, store, telemetry } = await setup();
    vi.spyOn(store, "list").mockRejectedValue(new Error("classification unavailable"));
    vi.spyOn(telemetry, "emit").mockImplementation(() => {
      throw new Error("spool unavailable");
    });
    expect((await call("/v1/model-keys/set", { providerId: "openai", apiKey: "test-key" })).status).toBe(200);
    expect(await store.get("openai")).toEqual({ type: "api", key: "test-key" });
  });

  it("uses the actual provider adapter with explicit stored auth and discards echoed provider errors", async () => {
    const { store, env, dir } = await setup();
    const marker = "MARKER_KEY_real_adapter_8492";
    await store.set("openai", { type: "api", key: marker });
    const runtime = await ModelRuntime.create({
      credentials: new BrokerCredentialStore(store),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: marker, type: "invalid_request_error" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const complete = runtime.complete.bind(runtime);
    vi.spyOn(runtime, "complete").mockImplementation((model, context, options) =>
      complete(model, context, { ...options, fetch: fetcher }),
    );
    const models = createModelKeys({ store, env, cwd: dir, runtime: async () => runtime });
    expect(ModelKeysResponseSchema.safeParse(await models.list()).success).toBe(true);
    expect(await models.validate("openai", "gpt-4.1-mini")).toEqual({
      ok: false,
      error: "validation_failed",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(diagnosticText(logs)).not.toContain(marker);
    const headers = new Headers((fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1].headers);
    expect(headers.get("authorization")).toBe(`Bearer ${marker}`);
  });

  it("reports timeout as a fixed code and never changes selection during validation", async () => {
    const { call, complete } = await setup();
    await call("/v1/model-keys/set", { providerId: "openai", apiKey: "test-key" });
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    complete.mockRejectedValueOnce(new Error("cancelled"));
    expect(
      await (await call("/v1/model-keys/validate", { providerId: "openai", modelId: "test/model" })).json(),
    ).toEqual({ ok: false, error: "validation_timeout" });
    expect(await (await call("/v1/model-keys")).json()).toMatchObject({ model: null, effectiveModel: null });
  });

  it("uses the CLI catalog/config and broker; lists only status, replaces, validates, selects and removes", async () => {
    const { call, store, env, dir, complete } = await setup();
    const listed = ModelKeysResponseSchema.parse(await (await call("/v1/model-keys")).json());
    expect(listed).toMatchObject({ model: null, effectiveModel: null });
    expect(listed.providers.map((p) => p.id)).toEqual(["oauth-only", "openai"]);
    expect(listed.providers.find((provider) => provider.id === "openai")).toMatchObject({
      acceptsApiKey: true,
      keyConfigured: false,
      models: [{ id: "test/model", name: "Test" }],
    });
    expect(
      await (await call("/v1/model-keys/validate", { providerId: "openai", modelId: "test/model" })).json(),
    ).toEqual({ ok: false, error: "key_missing" });
    for (const apiKey of ["first-secret", "replacement-secret"])
      expect(await (await call("/v1/model-keys/set", { providerId: "openai", apiKey })).json()).toEqual({
        ok: true,
      });
    expect(await store.get("openai")).toEqual({ type: "api", key: "replacement-secret" });
    expect(
      await (await call("/v1/model-keys/validate", { providerId: "openai", modelId: "test/model" })).json(),
    ).toEqual({ ok: true });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "test/model" }),
      {
        messages: [expect.objectContaining({ role: "user", content: "Reply OK." })],
      },
      expect.objectContaining({
        apiKey: "replacement-secret",
        maxTokens: 16,
        maxRetries: 0,
        timeoutMs: 15_000,
      }),
    );
    expect(await (await call("/v1/model-keys/select", { model: "openai/test/model" })).json()).toEqual({
      ok: true,
    });
    expect((await loadConfig({ env, cwd: dir })).config.model).toBe("openai/test/model");
    expect(await (await call("/v1/model-keys")).json()).toMatchObject({
      model: "openai/test/model",
      effectiveModel: "openai/test/model",
    });
    expect(await (await call("/v1/model-keys/remove", { providerId: "openai" })).json()).toEqual({
      ok: true,
    });
    expect(await store.get("openai")).toBeUndefined();
  });

  it("refuses every device grant combination without terminalControl, plus captain/worker/anonymous/revoked", async () => {
    const { call, pair, store } = await setup();
    const requests = [
      ["/v1/model-keys", undefined],
      ["/v1/model-keys/set", { providerId: "openai", apiKey: "secret" }],
      ["/v1/model-keys/validate", { providerId: "openai", modelId: "test/model" }],
      ["/v1/model-keys/select", { model: "openai/test/model" }],
      ["/v1/model-keys/remove", { providerId: "openai" }],
    ] as const;
    for (let mask = 0; mask < 8; mask++) {
      const device = await pair({
        chat: Boolean(mask & 1),
        steer: Boolean(mask & 2),
        terminalObserve: Boolean(mask & 4),
        terminalControl: false,
      });
      for (const [path, body] of requests)
        expect((await call(path, body, device.deviceToken)).status).toBe(403);
    }
    for (const token of ["", "anonymous", "captain", "worker-grant"])
      for (const [path, body] of requests) expect((await call(path, body, token)).status).toBe(401);
    expect(await store.get("openai")).toBeUndefined();
    const device = await pair(TAKE_CONTROL_GRANTS);
    expect(
      (await call("/v1/model-keys/set", { providerId: "openai", apiKey: "secret" }, device.deviceToken))
        .status,
    ).toBe(200);
    await call(`/v1/devices/${device.deviceId}/revoke`, {});
    for (const [path, body] of requests)
      expect((await call(path, body, device.deviceToken)).status).toBe(401);
  });

  it("never leaks a marker key through errors, responses, body logs, event log or telemetry", async () => {
    const { call, store, dir, telemetryDir, complete } = await setup();
    const marker = "MARKER_KEY_never_log_8ac88e";
    const output: string[] = [];
    const stderr = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => output.push(diagnosticText(args)));
    for (const path of ["set", "set"]) {
      output.push(
        await (await call(`/v1/model-keys/${path}`, { providerId: "openai", apiKey: marker })).text(),
      );
    }
    complete.mockRejectedValueOnce(new Error(`provider echoed ${marker}`));
    output.push(
      await (await call("/v1/model-keys/validate", { providerId: "openai", modelId: "test/model" })).text(),
    );
    complete.mockResolvedValueOnce({ stopReason: "error", errorMessage: marker } as never);
    output.push(
      await (await call("/v1/model-keys/validate", { providerId: "openai", modelId: "test/model" })).text(),
    );
    output.push(await (await call("/v1/model-keys")).text());
    output.push(
      await (
        await call("/v1/model-keys/set", { providerId: "openai", apiKey: marker, extra: marker })
      ).text(),
    );
    vi.spyOn(store, "set").mockRejectedValueOnce(new Error(`broker echoed ${marker}`));
    output.push(await (await call("/v1/model-keys/set", { providerId: "openai", apiKey: marker })).text());
    output.push(diagnosticText(logs), await readFile(join(dir, "events.jsonl"), "utf8").catch(() => ""));
    for (const file of await readdir(telemetryDir))
      output.push(await readFile(join(telemetryDir, file), "utf8"));
    expect(output.join("\n")).not.toContain(marker);
    expect(output.join("\n")).toContain("validation_failed");
    expect(output.join("\n")).toContain("unavailable");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("cannot overwrite internal broker entries, disabled providers or OAuth-only providers", async () => {
    const { call, store } = await setup();
    for (const providerId of ["clankie_operator", "clankie_captain", "oauth-only", "disabled", "unknown"])
      for (const action of ["set", "remove"])
        expect(
          await (
            await call(`/v1/model-keys/${action}`, {
              providerId,
              ...(action === "set" ? { apiKey: "key" } : {}),
            })
          ).json(),
        ).toEqual({ ok: false, error: "unsupported_provider" });
    await store.set("openai", {
      type: "oauth",
      access: "oauth-secret",
      refresh: "refresh",
      expires: Date.now() + 60000,
    });
    await call("/v1/model-keys/remove", { providerId: "openai" });
    expect((await store.get("openai"))?.type).toBe("oauth");
    expect(
      (await call("/v1/model-keys/set", { providerId: "openai", apiKey: "x".repeat(18000) })).status,
    ).toBe(413);
    expect((await call("/v1/model-keys/select", { model: "openai/missing" })).status).toBe(400);
    const device = await (await setup()).pair(SUPERVISE_GRANTS);
    expect((await call("/v1/model-keys", undefined, device.deviceToken)).status).toBe(401);
  });
});
