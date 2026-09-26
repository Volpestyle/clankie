import { createHash, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedFixture } from "./fixtures/hosted-body.ts";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, updateModelRouting } from "@clankie/model-provider";
import {
  applyHostedModelRouting,
  configureHostedModels,
  HOSTED_DEFAULT_MODEL,
  HostedBodyClient,
  HostedBodyDeniedError,
  readHostedBodyBootstrap,
} from "../src/hosted-body.ts";

describe("managed hosted credential", () => {
  it("is opt-in and rejects malformed or insecure bootstrap configuration", () => {
    expect(readHostedBodyBootstrap({})).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "hosted-bootstrap-"));
    try {
      const path = join(dir, "bootstrap.json");
      const { bootstrap } = hostedFixture();
      writeFileSync(path, JSON.stringify(bootstrap));
      expect(readHostedBodyBootstrap({ CLANKIE_HOSTED_BOOTSTRAP_FILE: path })).toEqual(bootstrap);
      writeFileSync(path, JSON.stringify({ ...bootstrap, gatewayOrigin: "http://example.test" }));
      expect(() => readHostedBodyBootstrap({ CLANKIE_HOSTED_BOOTSTRAP_FILE: path })).toThrow(
        "Invalid hosted body bootstrap file",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("accepts the fleet's optional tenant telemetry key while keeping the bootstrap strict", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosted-bootstrap-"));
    try {
      const path = join(dir, "bootstrap.json");
      const { bootstrap } = hostedFixture();
      const withTelemetry = { ...bootstrap, tenantTelemetryKey: Buffer.alloc(32, 7).toString("base64url") };
      writeFileSync(path, JSON.stringify(withTelemetry));
      expect(readHostedBodyBootstrap({ CLANKIE_HOSTED_BOOTSTRAP_FILE: path })).toEqual(withTelemetry);
      for (const invalid of [
        { ...withTelemetry, tenantTelemetryKey: "not-a-256-bit-key" },
        { ...withTelemetry, unexpectedSecret: "should-not-be-accepted" },
      ]) {
        writeFileSync(path, JSON.stringify(invalid));
        expect(() => readHostedBodyBootstrap({ CLANKIE_HOSTED_BOOTSTRAP_FILE: path })).toThrow(
          "Invalid hosted body bootstrap file",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("takes the plan's model routing from the bootstrap and writes it over the body's routing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hosted-bootstrap-"));
    try {
      const path = join(dir, "bootstrap.json");
      const { bootstrap } = hostedFixture();
      const routed = {
        ...bootstrap,
        modelRouting: {
          routineModel: "clankie/routine",
          escalate: true,
          escalationModel: "clankie/escalation",
        },
      };
      writeFileSync(path, JSON.stringify(routed));
      const read = readHostedBodyBootstrap({ CLANKIE_HOSTED_BOOTSTRAP_FILE: path });
      expect(read).toEqual(routed);
      for (const invalid of [
        { ...routed, modelRouting: { routineModel: "no-slash", escalate: false } },
        { ...routed, modelRouting: { ...routed.modelRouting, apiKey: "sk-should-not-be-accepted" } },
      ]) {
        writeFileSync(path, JSON.stringify(invalid));
        expect(() => readHostedBodyBootstrap({ CLANKIE_HOSTED_BOOTSTRAP_FILE: path })).toThrow(
          "Invalid hosted body bootstrap file",
        );
      }

      const env = { XDG_CONFIG_HOME: dir };
      await updateModelRouting({ purposes: { gameplay: "routine" }, escalationModel: "openai/old" }, { env });
      await applyHostedModelRouting(read!, { env });
      expect((await loadConfig({ env, cwd: dir })).config.routing).toEqual({
        purposes: { gameplay: "routine" },
        routine_model: "clankie/routine",
        escalate: true,
        escalation_model: "clankie/escalation",
      });
      // A Starter plan drops escalation and its model; the body's own purpose choices stay.
      await applyHostedModelRouting(
        { modelRouting: { routineModel: "clankie/routine", escalate: false } },
        { env },
      );
      expect((await loadConfig({ env, cwd: dir })).config.routing).toEqual({
        purposes: { gameplay: "routine" },
        routine_model: "clankie/routine",
        escalate: false,
      });
      // No routing in the bootstrap leaves the body's config alone.
      await applyHostedModelRouting({}, { env });
      expect((await loadConfig({ env, cwd: dir })).config.routing?.routine_model).toBe("clankie/routine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("shares a single half-life renewal across connector and fleet calls and persists it", async () => {
    const f = hostedFixture();
    let now = f.now;
    const persist = vi.fn(async () => {});
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("host-credential")
        ? Response.json({
            credential: f.host(now / 1000),
            expiresAtMs: now + 21600000,
            tenantTelemetryKey: Buffer.alloc(32, 7).toString("base64url"),
          })
        : Response.json({}),
    );
    const client = new HostedBodyClient(f.bootstrap, { fetch: fetcher, clock: () => now, persist });
    expect((await client.resolveHostToken()).token).toBe(f.bootstrap.hostCredential);
    expect(fetcher).not.toHaveBeenCalled();
    await client.registerPairingKey(generateKeyPairSync("ed25519").privateKey);
    fetcher.mockClear();
    now += 10800000;
    const [next] = await Promise.all([
      client.resolveHostToken(),
      client.registerWakeKey("device-one", "public-key"),
    ]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("host-credential"))).toHaveLength(1);
    expect(persist).toHaveBeenCalledWith(next.token, next.expiresAt);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: { authorization: `Bearer ${next.token}` },
      body: JSON.stringify({
        deviceId: "device-one",
        publicKey: "public-key",
        installationId: f.bootstrap.installationId,
      }),
    });
    await client.revokeWakeKey("device-one");
    expect(String(fetcher.mock.calls[2]?.[0])).toContain("/fleet/v1/body/wake-keys/revoke");
  });
  it("parks on 403 and never sends another request", async () => {
    const f = hostedFixture();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
    fetcher.mockResolvedValueOnce(Response.json({}));
    const client = new HostedBodyClient(f.bootstrap, { fetch: fetcher, clock: () => f.now + 10800000 });
    await client.registerPairingKey(generateKeyPairSync("ed25519").privateKey);
    fetcher.mockClear();
    client.onDenied = vi.fn();
    await expect(client.resolveHostToken()).rejects.toBeInstanceOf(HostedBodyDeniedError);
    await expect(client.registerWakeKey("device-one", "key")).rejects.toBeInstanceOf(HostedBodyDeniedError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.onDenied).toHaveBeenCalledTimes(1);
  });
  it("checks signature, audience, tenant, host, expiry and bounded lifetime of pair tickets", () => {
    const f = hostedFixture(),
      client = new HostedBodyClient(f.bootstrap, { clock: () => f.now });
    expect(client.verifyPairTicket(f.pair(), f.browserPublicKey, f.nonce).jti).toBe("j".repeat(22));
    for (const claims of [
      { aud: "clankie-gateway" },
      { tid: `tn_${"b".repeat(20)}` },
      { hid: "x".repeat(43) },
      { exp: f.now / 1000 },
      { exp: f.now / 1000 + 121 },
      { iat: f.now / 1000 + 61 },
    ])
      expect(() => client.verifyPairTicket(f.pair(claims), f.browserPublicKey, f.nonce)).toThrow();
    expect(() => client.verifyPairTicket(hostedFixture().pair(), f.browserPublicKey, f.nonce)).toThrow();
  });
});

/** Independently reconstruct the fleet's eight-line wire contract from captured request bytes. */
function verifyCall(url: string | URL | Request, init: RequestInit | undefined, key: KeyObject) {
  const f = hostedFixture();
  const headers = new Headers(init?.headers);
  const timestamp = headers.get("x-clankie-body-timestamp");
  const nonce = headers.get("x-clankie-body-nonce");
  const signature = headers.get("x-clankie-body-signature");
  expect(timestamp).toMatch(/^[0-9]+$/u);
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
  expect(init?.method).toBe("POST");
  expect(typeof init?.body).toBe("string");
  // The transcript's last line, sent ahead of the body so the fleet can verify before reading it.
  const digest = createHash("sha256").update(String(init?.body)).digest("base64url");
  expect(headers.get("x-clankie-body-digest")).toBe(digest);
  const transcript = Buffer.from(
    [
      "clankie-body-request-v1",
      "POST",
      new URL(String(url)).pathname,
      f.bootstrap.tenantId,
      f.bootstrap.installationId,
      timestamp,
      nonce,
      digest,
    ].join("\n"),
  );
  expect(verify(null, transcript, key, Buffer.from(signature!, "base64url"))).toBe(true);
  expect(
    verify(null, Buffer.concat([transcript, Buffer.from("\n")]), key, Buffer.from(signature!, "base64url")),
  ).toBe(false);
}

describe("signed body fleet calls", () => {
  it("registers before half-life renewal, then signs all four routes over exact UTF-8 bytes", async () => {
    const f = hostedFixture(),
      signing = generateKeyPairSync("ed25519");
    const now = f.now + 10_800_000;
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("host-credential")
        ? Response.json({ credential: f.host(now / 1000), expiresAtMs: now + 21_600_000 })
        : Response.json({}),
    );
    const client = new HostedBodyClient(f.bootstrap, { clock: () => now, fetch: fetcher });
    await expect(client.post("heartbeat", {})).rejects.toThrow("not registered");
    expect(fetcher).not.toHaveBeenCalled();
    await client.registerPairingKey(signing.privateKey);
    expect(new URL(String(fetcher.mock.calls[0]![0])).pathname).toBe("/fleet/v1/body/pairing-key");
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("x-clankie-body-signature")).toBeNull();
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
      authorization: `Bearer ${f.bootstrap.hostCredential}`,
    });
    await client.post("heartbeat", { busy: true, reasons: ["captain-turn"], note: '☃\nquoted"' });
    await client.registerWakeKey("device", "public-key");
    await client.revokeWakeKey("device");
    expect(fetcher.mock.calls.slice(1).map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/fleet/v1/body/host-credential",
      "/fleet/v1/body/heartbeat",
      "/fleet/v1/body/wake-keys",
      "/fleet/v1/body/wake-keys/revoke",
    ]);
    expect(fetcher.mock.calls[1]![1]?.body).toBe("{}");
    for (const [url, init] of fetcher.mock.calls.slice(1)) verifyCall(url, init, signing.publicKey);
  });

  it("retries signature rejection with fresh timestamp/nonce, then reports a code and stops", async () => {
    const f = hostedFixture(),
      signing = generateKeyPairSync("ed25519");
    let now = f.now;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      now++;
      return String(url).endsWith("pairing-key")
        ? Response.json({})
        : Response.json({ error: "body_signature_invalid" }, { status: 401 });
    });
    const client = new HostedBodyClient(f.bootstrap, { clock: () => now, fetch: fetcher });
    client.onDenied = vi.fn();
    client.onSignatureInvalid = vi.fn();
    await client.registerPairingKey(signing.privateKey);
    await expect(client.post("heartbeat", {})).rejects.toThrow("401");
    const calls = fetcher.mock.calls.slice(1);
    expect(calls).toHaveLength(3);
    for (const [url, init] of calls) verifyCall(url, init, signing.publicKey);
    expect(
      new Set(calls.map(([, init]) => new Headers(init?.headers).get("x-clankie-body-nonce"))).size,
    ).toBe(3);
    expect(
      new Set(calls.map(([, init]) => new Headers(init?.headers).get("x-clankie-body-timestamp"))).size,
    ).toBe(3);
    expect(new Set(calls.map(([, init]) => init?.body)).size).toBe(1);
    expect(client.onSignatureInvalid).toHaveBeenCalledExactlyOnceWith();
    expect(client.onDenied).not.toHaveBeenCalled();
  });

  it("retries a lost registration response and 5xx using exactly the same token and public key", async () => {
    const f = hostedFixture(),
      signing = generateKeyPairSync("ed25519");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    fetcher
      .mockRejectedValueOnce(new Error("lost response with secret context"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const client = new HostedBodyClient(f.bootstrap, { clock: () => f.now, fetch: fetcher });
    await client.registerPairingKey(signing.privateKey);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new Set(fetcher.mock.calls.map(([, init]) => init?.body)).size).toBe(1);
    for (const [, init] of fetcher.mock.calls) {
      expect(JSON.parse(String(init?.body)).registrationToken).toBe(f.bootstrap.pairingKeyRegistrationToken);
      expect(new Headers(init?.headers).get("x-clankie-body-signature")).toBeNull();
    }
    await client.post("heartbeat", {});
    verifyCall(...fetcher.mock.calls[3]!, signing.publicKey);
  });

  it("re-registers a missing fleet key once, retries signed call, and does not park", async () => {
    const f = hostedFixture(),
      signing = generateKeyPairSync("ed25519");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    const client = new HostedBodyClient(f.bootstrap, { clock: () => f.now, fetch: fetcher });
    client.onDenied = vi.fn();
    await client.registerPairingKey(signing.privateKey);
    fetcher.mockResolvedValueOnce(Response.json({ error: "pairing_key_required" }, { status: 403 }));
    await client.post("heartbeat", {});
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/fleet/v1/body/pairing-key",
      "/fleet/v1/body/heartbeat",
      "/fleet/v1/body/pairing-key",
      "/fleet/v1/body/heartbeat",
    ]);
    expect(fetcher.mock.calls[0]![1]?.body).toBe(fetcher.mock.calls[2]![1]?.body);
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get("x-clankie-body-nonce")).not.toBe(
      new Headers(fetcher.mock.calls[3]![1]?.headers).get("x-clankie-body-nonce"),
    );
    expect(client.onDenied).not.toHaveBeenCalled();
  });

  it("does not loop or park when re-registration cannot fix pairing_key_required", async () => {
    const f = hostedFixture(),
      signing = generateKeyPairSync("ed25519");
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("pairing-key")
        ? Response.json({})
        : Response.json({ error: "pairing_key_required" }, { status: 403 }),
    );
    const client = new HostedBodyClient(f.bootstrap, { clock: () => f.now, fetch: fetcher });
    client.onDenied = vi.fn();
    await client.registerPairingKey(signing.privateKey);
    await expect(client.post("heartbeat", {})).rejects.toThrow("pairing_key_required");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(client.onDenied).not.toHaveBeenCalled();
  });

  it("signs with a replacement key only after its registration succeeds", async () => {
    const f = hostedFixture(),
      first = generateKeyPairSync("ed25519"),
      next = generateKeyPairSync("ed25519");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    const client = new HostedBodyClient(f.bootstrap, { clock: () => f.now, fetch: fetcher });
    await client.registerPairingKey(first.privateKey);
    await client.post("heartbeat", {});
    verifyCall(...fetcher.mock.calls[1]!, first.publicKey);
    await client.registerPairingKey(next.privateKey);
    await client.post("heartbeat", {});
    verifyCall(...fetcher.mock.calls[3]!, next.publicKey);
  });

  it("does not retry ordinary authentication failures or expose transport error secrets", async () => {
    const f = hostedFixture(),
      signing = generateKeyPairSync("ed25519");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    const client = new HostedBodyClient(f.bootstrap, { clock: () => f.now, fetch: fetcher });
    await client.registerPairingKey(signing.privateKey);
    fetcher.mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(client.post("heartbeat", {})).rejects.toThrow("Fleet request failed (401)");
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockRejectedValueOnce(new Error(f.bootstrap.hostCredential));
    await expect(client.post("heartbeat", {})).rejects.toThrow("Fleet request unavailable");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("included model calls (VUH-1371)", () => {
  const proxyError = (status: number, code: string, type = "invalid_request_error") =>
    Response.json({ error: { message: `refused: ${code}`, type, code } }, { status });
  async function registered(fetcher: typeof fetch) {
    const f = hostedFixture(),
      signing = generateKeyPairSync("ed25519");
    const client = new HostedBodyClient(f.bootstrap, { clock: () => f.now, fetch: fetcher });
    await client.registerPairingKey(signing.privateKey);
    return { f, client, signing };
  }
  const modelCalls = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) =>
    fetcher.mock.calls.filter(([url]) => String(url).includes("/fleet/v1/model/"));

  it("signs the exact bytes to the model proxy, with the digest header, and relays the answer", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/model/")
        ? new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
        : Response.json({}),
    );
    const { f, client, signing } = await registered(fetcher);
    const bytes = new Uint8Array(Buffer.from('{"model":"default","input":"☃","stream":true}'));
    const answer = await client.forwardModel("responses", bytes);
    expect(answer.headers.get("content-type")).toBe("text/event-stream");
    expect(await answer.text()).toBe("data: {}\n\n");
    const [[url, init]] = modelCalls(fetcher) as [[string, RequestInit]];
    expect(new URL(url).href).toBe(`${f.bootstrap.gatewayOrigin}/fleet/v1/model/v1/responses`);
    expect(init.body).toBe(bytes);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${f.bootstrap.hostCredential}`);
    const digest = createHash("sha256").update(bytes).digest("base64url");
    expect(headers.get("x-clankie-body-digest")).toBe(digest);
    const transcript = [
      "clankie-body-request-v1",
      "POST",
      "/fleet/v1/model/v1/responses",
      f.bootstrap.tenantId,
      f.bootstrap.installationId,
      headers.get("x-clankie-body-timestamp"),
      headers.get("x-clankie-body-nonce"),
      digest,
    ].join("\n");
    expect(
      verify(
        null,
        Buffer.from(transcript),
        signing.publicKey,
        Buffer.from(headers.get("x-clankie-body-signature")!, "base64url"),
      ),
    ).toBe(true);
  });

  it("re-signs a rejected signature up to three times, each with a fresh nonce", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/model/") ? proxyError(401, "body_signature_invalid") : Response.json({}),
    );
    const { client } = await registered(fetcher);
    client.onSignatureInvalid = vi.fn();
    const answer = await client.forwardModel("chat/completions", new Uint8Array(Buffer.from("{}")));
    expect(answer.status).toBe(401);
    const nonces = modelCalls(fetcher).map(([, init]) =>
      new Headers(init?.headers).get("x-clankie-body-nonce"),
    );
    expect(nonces).toHaveLength(3);
    expect(new Set(nonces).size).toBe(3);
    expect(client.onSignatureInvalid).toHaveBeenCalledOnce();
  });

  it("re-registers a missing pairing key once, then sends the call again", async () => {
    let model = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/model/")
        ? model++ === 0
          ? Response.json({ error: "pairing_key_required" }, { status: 403 })
          : Response.json({ id: "resp" })
        : Response.json({}),
    );
    const { client } = await registered(fetcher);
    const answer = await client.forwardModel("responses", new Uint8Array(Buffer.from("{}")));
    expect(answer.status).toBe(200);
    const paths = fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).toEqual([
      "/fleet/v1/body/pairing-key",
      "/fleet/v1/model/v1/responses",
      "/fleet/v1/body/pairing-key",
      "/fleet/v1/model/v1/responses",
    ]);
  });

  it.each([
    [429, "allowance_exhausted", "insufficient_quota"],
    [429, "daily_cap", "insufficient_quota"],
    [429, "rate_limited", "rate_limit_error"],
    [409, "replayed", "invalid_request_error"],
    [403, "not_entitled", "invalid_request_error"],
    [403, "escalation_not_in_plan", "invalid_request_error"],
    [400, "unsupported_model", "invalid_request_error"],
  ] as const)("never retries %i %s, and never parks the body for it", async (status, code, type) => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/model/") ? proxyError(status, code, type) : Response.json({}),
    );
    const { client } = await registered(fetcher);
    client.onDenied = vi.fn();
    const answer = await client.forwardModel("responses", new Uint8Array(Buffer.from("{}")));
    expect(answer.status).toBe(status);
    expect(await answer.json()).toMatchObject({ error: { code } });
    expect(modelCalls(fetcher)).toHaveLength(1);
    expect(client.onDenied).not.toHaveBeenCalled();
    // The next call still goes out: a refusal is not a revoked body.
    await client.forwardModel("responses", new Uint8Array(Buffer.from("{}")));
    expect(modelCalls(fetcher)).toHaveLength(2);
  });

  it("retries one network failure before any answer with a new nonce, and no more", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/model/")) throw new TypeError("fetch failed");
      return Response.json({});
    });
    const { client } = await registered(fetcher);
    await expect(client.forwardModel("responses", new Uint8Array(Buffer.from("{}")))).rejects.toThrow();
    const nonces = modelCalls(fetcher).map(([, init]) =>
      new Headers(init?.headers).get("x-clankie-body-nonce"),
    );
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});

describe("included model selection (VUH-1371)", () => {
  async function withConfig(
    initial: Record<string, unknown> | undefined,
    run: (env: NodeJS.ProcessEnv) => Promise<void>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "hosted-models-"));
    try {
      if (initial !== undefined) {
        mkdirSync(join(dir, "clankie"), { recursive: true });
        writeFileSync(join(dir, "clankie", "clankie.json"), JSON.stringify(initial));
      }
      await run({ XDG_CONFIG_HOME: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const noCredentials = async () => false;

  it("points the included provider at the forwarder and selects it on a new body", async () => {
    await withConfig(undefined, async (env) => {
      await configureHostedModels("http://127.0.0.1:4319/v1", { env, hasCredential: noCredentials });
      const { config } = await loadConfig({ env });
      expect(config.model).toBe(HOSTED_DEFAULT_MODEL);
      expect(config.provider?.clankie).toMatchObject({
        npm: "@ai-sdk/openai",
        options: { baseURL: "http://127.0.0.1:4319/v1" },
      });
      expect(Object.keys(config.provider?.clankie?.models ?? {}).sort()).toEqual([
        "default",
        "escalation",
        "routine",
      ]);
    });
  });

  it.each([
    ["an API key", "openai/gpt-6-luna", "openai"],
    ["a subscription login", "openai-codex/gpt-6-astra", "openai-codex"],
  ])("keeps a customer model backed by %s", async (_kind, model, provider) => {
    await withConfig({ model }, async (env) => {
      await configureHostedModels("http://127.0.0.1:4319/v1", {
        env,
        hasCredential: async (providerId) => providerId === provider,
      });
      expect((await loadConfig({ env })).config.model).toBe(model);
    });
  });

  it("returns a customer model whose credential is gone to the included model", async () => {
    await withConfig({ model: "openai/gpt-6-luna" }, async (env) => {
      await configureHostedModels("http://127.0.0.1:4319/v1", { env, hasCredential: noCredentials });
      expect((await loadConfig({ env })).config.model).toBe(HOSTED_DEFAULT_MODEL);
    });
  });
});
