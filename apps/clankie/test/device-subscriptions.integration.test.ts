import { once } from "node:events";
import { serve } from "@hono/node-server";
import { runHeadlessCaptainCommand } from "../../tui/bin/headless-captain.ts";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { loadConfig, setCaptainModel } from "@clankie/model-provider";
import { TAKE_CONTROL_GRANTS, SUPERVISE_GRANTS } from "@clankie/protocol";
import { CaptainReadinessResponseSchema } from "@clankie/protocol/captain-readiness";
import {
  ModelSubscriptionResultSchema,
  ModelSubscriptionsResponseSchema,
} from "@clankie/protocol/model-keys";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createModelKeys } from "../src/model-keys.ts";

// Integration fixture issues synthetic provider tokens over real HTTP. The real
// browser callback, PKCE code exchange, broker, config, API and schemas run here.
// It proves our boundary, not acceptance by a live subscription provider.
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
async function fixture(
  options: {
    hosted?: boolean;
    operatorSeat?: boolean;
    timeoutMs?: number;
    hold?: boolean;
    holdCommit?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "device-auth-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const env = {
    XDG_CONFIG_HOME: dir,
    CLANKIE_DISABLE_MODELS_FETCH: "1",
    CLANKIE_MODELS_PATH: join(dir, "catalog.json"),
    ...(options.hosted ? { CLANKIE_HOSTED_BOOTSTRAP_FILE: join(dir, "hosted.json") } : {}),
  };
  await writeFile(env.CLANKIE_MODELS_PATH, "{}");
  await mkdir(join(dir, "clankie"));
  const store = new FileCredentialStore(join(dir, "credentials.json"));
  let release!: () => void;
  const held = options.hold
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  let exchanges = 0;
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain the actual form request */
    }
    exchanges++;
    await held;
    if (res.destroyed) return;
    const path = req.url ?? "";
    const body = path.includes("device/code")
      ? {
          device_code: "synthetic-device",
          user_code: "TEST-CODE",
          verification_uri: "https://auth.x.ai/device",
          interval: 1,
          expires_in: 300,
        }
      : {
          access_token: "synthetic-token-marker",
          refresh_token: "synthetic-refresh-marker",
          expires_in: 3600,
        };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const providerOrigin = await listen(provider);
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        release?.();
        provider.closeAllConnections();
        provider.close(() => resolve());
      }),
  );
  const transport: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    return fetch(providerOrigin + url.pathname, init);
  };
  let releaseCommit!: () => void;
  let reachedCommit!: () => void;
  const commitReached = new Promise<void>((resolve) => {
    reachedCommit = resolve;
  });
  const committed = options.holdCommit
    ? new Promise<void>((resolve) => {
        releaseCommit = resolve;
      })
    : Promise.resolve();
  cleanup.push(() => releaseCommit?.());
  const models = createModelKeys({
    store,
    env,
    cwd: dir,
    onModelChanged: () => {
      reachedCommit();
      return committed;
    },
    subscriptionLogin: { browserPort: 0, fetchImpl: transport, timeoutMs: options.timeoutMs ?? 3000 },
  });
  const operatorToken = "clankie_op_" + "a".repeat(43);
  const captain = createStubCaptain();
  if (options.operatorSeat) captain.operatorSeatReady = () => true;
  const app = await createClankieApp({
    captain,
    modelKeys: models,
    modelDeviceSetup: { platform: "darwin", hosted: Boolean(options.hosted) },
    eventLogPath: join(dir, "events.jsonl"),
    deviceSessionKey: randomBytes(32),
    authenticateOperator: async (request) =>
      ["Bearer owner", `Bearer ${operatorToken}`].includes(request.headers.get("authorization") ?? "")
        ? { operatorId: "owner" }
        : undefined,
  });
  const server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const cli = async (args: string[], fetchImpl: typeof fetch = fetch) => {
    let stdout = "",
      stderr = "";
    const exit = await runHeadlessCaptainCommand(["model", "subscriptions", ...args], {
      repoRoot: dir,
      host: origin,
      fetchImpl,
      env: { ...env, CLANKIE_OPERATOR_TOKEN: operatorToken },
      stdout: {
        write: (text: string) => {
          stdout += text;
        },
      },
      stderr: {
        write: (text: string) => {
          stderr += text;
        },
      },
    });
    return { exit, stdout, stderr, value: stdout ? JSON.parse(stdout) : undefined };
  };
  const principals = new Map<string, string>();
  const sessions: { sessionId: string; principal: string }[] = [];
  cleanup.push(async () => {
    await app.close();
    release?.();
    releaseCommit?.();
    // close cancels pending logins, but admitted broker/config writes finish.
    // Observe their terminal state before removing the fixture they still own.
    for (const { sessionId, principal } of sessions) {
      for (let i = 0; ; i++) {
        const value = models.subscriptionStatus!(sessionId, principal);
        if (!value.ok || value.state !== "committing") break;
        if (i === 150) throw Error("admitted subscription did not settle before fixture cleanup");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  });
  const call = (path: string, body?: unknown, token = "owner") =>
    fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const pair = async (grants = TAKE_CONTROL_GRANTS) => {
    const offer = await (await call("/v1/pairing/offer", {})).json();
    const pending = await (
      await call("/v1/pairing/redeem", {
        offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
        device: { name: "Mac pet", platform: "macos" },
      })
    ).json();
    const paired = await (
      await call("/v1/pairing/complete", { completionToken: pending.completionToken, acceptedGrants: grants })
    ).json();
    principals.set(paired.deviceToken, `device:${paired.deviceId}`);
    return paired;
  };
  const catalog = await models.list();
  const model = (providerId: string) =>
    `${providerId}/${catalog.providers.find((p) => p.id === providerId)!.models[0]!.id}`;
  const status = async (sessionId: string, token: string) =>
    ModelSubscriptionResultSchema.parse(
      await (await call("/v1/model-keys/subscriptions/status", { sessionId }, token)).json(),
    );
  const wait = async (
    sessionId: string,
    token: string,
    predicate: (value: Awaited<ReturnType<typeof status>>) => boolean,
  ) => {
    for (let i = 0; i < 150; i++) {
      const value = await status(sessionId, token);
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error("session did not reach expected state");
  };
  const start = async (token: string, providerId = "openai-codex", method = "browser") => {
    const response = await call(
      "/v1/model-keys/subscriptions/start",
      { providerId, method, model: model(providerId) },
      token,
    );
    const value = ModelSubscriptionResultSchema.parse(await response.json());
    expect(response.status).toBe(200);
    expect(value.ok).toBe(true);
    if (!value.ok) throw Error(value.error);
    sessions.push({ sessionId: value.sessionId, principal: principals.get(token) ?? "operator:owner" });
    return value;
  };
  const callback = async (url: string) => {
    const authorize = new URL(url);
    const callbackUrl = new URL(authorize.searchParams.get("redirect_uri")!);
    callbackUrl.hostname = "127.0.0.1";
    callbackUrl.searchParams.set("state", authorize.searchParams.get("state")!);
    callbackUrl.searchParams.set("code", "synthetic-code");
    return fetch(callbackUrl);
  };
  return {
    dir,
    cli,
    env,
    store,
    models,
    call,
    pair,
    model,
    wait,
    start,
    status,
    callback,
    release: () => release?.(),
    releaseCommit: () => releaseCommit?.(),
    commitReached,
    exchanges: () => exchanges,
  };
}

describe("device subscription setup", () => {
  it("completes a real browser callback into broker/config, updates both readiness readers and closes device key entry", async () => {
    const f = await fixture();
    const device = await f.pair();
    expect(await (await f.call("/v1/captain/readiness", undefined, device.deviceToken)).json()).toEqual({
      ready: false,
      reason: "no_model",
    });
    const login = await f.start(device.deviceToken);
    const interaction = await f.wait(login.sessionId, device.deviceToken, (v) => v.ok && Boolean(v.url));
    if (!interaction.ok || !interaction.url) throw Error("missing interaction");
    const other = await f.pair();
    expect((await f.status(login.sessionId, other.deviceToken)).ok).toBe(false);
    const foreign = new URL(new URL(interaction.url).searchParams.get("redirect_uri")!);
    foreign.hostname = "127.0.0.1";
    foreign.searchParams.set("state", "foreign");
    foreign.searchParams.set("code", "foreign");
    expect((await fetch(foreign)).status).toBe(400);
    expect((await f.callback(interaction.url)).status).toBe(200);
    const done = await f.wait(
      login.sessionId,
      device.deviceToken,
      (v) => v.ok && v.state !== "pending" && v.state !== "committing",
    );
    expect(done).toMatchObject({ ok: true, state: "complete" });
    expect(done).not.toHaveProperty("url");
    for (const token of ["owner", device.deviceToken]) {
      expect(
        CaptainReadinessResponseSchema.parse(
          await (await f.call("/v1/captain/readiness", undefined, token)).json(),
        ).ready,
      ).toBe(true);
    }
    expect((await loadConfig({ env: f.env, cwd: f.dir })).config.model).toBe(f.model("openai-codex"));
    expect((await f.store.get("openai-codex"))?.type).toBe("oauth");
    ModelSubscriptionsResponseSchema.parse(await (await f.call("/v1/model-keys/subscriptions")).json());
    expect(
      (
        await f.call(
          "/v1/model-keys/set",
          { providerId: "openai", apiKey: "after-ready-marker" },
          device.deviceToken,
        )
      ).status,
    ).toBe(403);
    expect(await f.store.get("openai")).toBeUndefined();
    expect(
      (await f.call("/v1/model-keys/set", { providerId: "openai", apiKey: "owner-key-marker" })).status,
    ).toBe(200);
    expect(await readFile(join(f.dir, "events.jsonl"), "utf8")).not.toContain("synthetic-token-marker");
  });

  it("allows device keys only during current first-run readiness, reflects terminal completion, and preserves hosted behavior", async () => {
    const f = await fixture();
    const device = await f.pair();
    expect(
      (
        await f.call(
          "/v1/model-keys/set",
          { providerId: "openai", apiKey: "first-key-marker" },
          device.deviceToken,
        )
      ).status,
    ).toBe(200);
    await setCaptainModel(f.model("openai"), { env: f.env }); // the console's same config write
    expect((await (await f.call("/v1/captain/readiness", undefined, device.deviceToken)).json()).ready).toBe(
      true,
    );
    expect(
      (
        await f.call(
          "/v1/model-keys/set",
          { providerId: "openai", apiKey: "second-key-marker" },
          device.deviceToken,
        )
      ).status,
    ).toBe(403);
    const seat = await fixture({ operatorSeat: true });
    const pet = await seat.pair();
    expect(
      (
        await seat.call(
          "/v1/model-keys/set",
          { providerId: "openai", apiKey: "seat-key-marker" },
          pet.deviceToken,
        )
      ).status,
    ).toBe(403);
    const hosted = await fixture({ hosted: true });
    const phone = await hosted.pair();
    await hosted.store.set("openai", { type: "api", key: "existing" });
    await setCaptainModel(hosted.model("openai"), { env: hosted.env });
    expect(
      (
        await hosted.call(
          "/v1/model-keys/set",
          { providerId: "openai", apiKey: "hosted-key-marker" },
          phone.deviceToken,
        )
      ).status,
    ).toBe(200);
    const methods = await (await hosted.call("/v1/model-keys/subscriptions/methods")).json();
    expect(methods.methods.some((p: { providerId: string }) => p.providerId === "openai-codex")).toBe(false);
  });

  it("cancels and expires pending browser sign-ins without storing credentials, and rejects supervise/provider-policy bypasses", async () => {
    const f = await fixture({ timeoutMs: 500 });
    const device = await f.pair();
    const viewer = await f.pair(SUPERVISE_GRANTS);
    expect(
      (
        await f.call(
          "/v1/model-keys/subscriptions/start",
          { providerId: "openai-codex", method: "browser", model: f.model("openai-codex") },
          viewer.deviceToken,
        )
      ).status,
    ).toBe(403);
    expect(
      await (
        await f.call(
          "/v1/model-keys/subscriptions/start",
          { providerId: "anthropic", method: "browser", model: "anthropic/claude-sonnet-4-5" },
          device.deviceToken,
        )
      ).json(),
    ).toEqual({ ok: false, error: "unsupported_provider" });
    const first = await f.start(device.deviceToken);
    expect(
      (
        await f.call(
          "/v1/model-keys/subscriptions/start",
          { providerId: "xai", method: "device", model: f.model("xai") },
          device.deviceToken,
        )
      ).status,
    ).toBe(409);
    expect(
      await (
        await f.call(
          "/v1/model-keys/subscriptions/cancel",
          { sessionId: first.sessionId },
          device.deviceToken,
        )
      ).json(),
    ).toMatchObject({ state: "cancelled" });
    const second = await f.start(device.deviceToken);
    expect(
      await f.wait(
        second.sessionId,
        device.deviceToken,
        (v) => v.ok && v.state !== "pending" && v.state !== "committing",
      ),
    ).toMatchObject({ state: "expired" });
    expect(await f.store.get("openai-codex")).toBeUndefined();
  });

  it("rechecks initiating device authority when the provider finishes after revocation", async () => {
    const f = await fixture({ hold: true });
    const device = await f.pair();
    const login = await f.start(device.deviceToken);
    const interaction = await f.wait(login.sessionId, device.deviceToken, (v) => v.ok && Boolean(v.url));
    if (!interaction.ok || !interaction.url) throw Error("missing interaction");
    await f.callback(interaction.url);
    await f.call(`/v1/devices/${device.deviceId}/revoke`, {});
    f.release();
    for (let i = 0; i < 100 && f.exchanges() === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await f.store.get("openai-codex")).toBeUndefined();
    expect(
      (
        await f.call(
          "/v1/model-keys/subscriptions/status",
          { sessionId: login.sessionId },
          device.deviceToken,
        )
      ).status,
    ).toBe(401);
  });

  it("reports an admitted commit during cancellation and lets it finish selection", async () => {
    const f = await fixture({ holdCommit: true });
    const device = await f.pair();
    const login = await f.start(device.deviceToken);
    const interaction = await f.wait(login.sessionId, device.deviceToken, (v) => v.ok && Boolean(v.url));
    if (!interaction.ok || !interaction.url) throw Error("missing interaction");
    await f.callback(interaction.url);
    expect(
      await f.wait(login.sessionId, device.deviceToken, (v) => v.ok && v.state === "committing"),
    ).toMatchObject({ state: "committing" });
    // Admission precedes the broker write; this real callback is reached only
    // after both credentials and model selection are durable.
    await f.commitReached;
    expect(
      await (
        await f.call(
          "/v1/model-keys/subscriptions/cancel",
          { sessionId: login.sessionId },
          device.deviceToken,
        )
      ).json(),
    ).toMatchObject({ state: "committing" });
    expect((await f.store.get("openai-codex"))?.type).toBe("oauth");
    f.releaseCommit();
    expect(
      await f.wait(
        login.sessionId,
        device.deviceToken,
        (v) => v.ok && v.state !== "pending" && v.state !== "committing",
      ),
    ).toMatchObject({ state: "complete" });
  });

  it("runs the SuperGrok device-code helper into the same broker/model/readiness path", async () => {
    const f = await fixture();
    const device = await f.pair();
    const login = await f.start(device.deviceToken, "xai", "device");
    expect(
      await f.wait(
        login.sessionId,
        device.deviceToken,
        (v) => v.ok && v.state !== "pending" && v.state !== "committing",
      ),
    ).toMatchObject({ state: "complete" });
    expect((await f.store.get("xai"))?.type).toBe("oauth");
    expect((await (await f.call("/v1/captain/readiness", undefined, device.deviceToken)).json()).ready).toBe(
      true,
    );
  });
});

it("headless subscription jobs use the same service broker and readiness as paired devices", async () => {
  const f = await fixture();
  const device = await f.pair();
  const methods = await f.cli(["methods"]);
  expect(methods.exit).toBe(0);
  expect(methods.value.methods.map((method: { providerId: string }) => method.providerId)).not.toContain(
    "anthropic",
  );
  const login = await f.cli([
    "start",
    "openai-codex",
    "--method",
    "browser",
    "--model",
    f.model("openai-codex"),
  ]);
  expect(login.exit).toBe(0);
  const interaction = await f.wait(login.value.sessionId, "owner", (value) => value.ok && Boolean(value.url));
  if (!interaction.ok || !interaction.url) throw Error("missing interaction");
  expect(await f.status(login.value.sessionId, device.deviceToken)).toEqual({
    ok: false,
    error: "session_not_found",
  });
  await f.callback(interaction.url);
  await f.wait(login.value.sessionId, "owner", (value) => value.ok && value.state === "complete");
  const status = await f.cli(["status", login.value.sessionId]);
  expect(status).toMatchObject({ exit: 0, value: { ok: true, state: "complete" } });
  expect(status.value).not.toHaveProperty("url");
  expect(status.value).not.toHaveProperty("userCode");
  expect((await f.cli(["list"])).value.subscriptions).toContainEqual({
    providerId: "openai-codex",
    name: expect.any(String),
  });
  for (const token of ["owner", device.deviceToken])
    expect((await (await f.call("/v1/captain/readiness", undefined, token)).json()).ready).toBe(true);
  for (const output of [login.stdout, status.stdout, await readFile(join(f.dir, "events.jsonl"), "utf8")]) {
    expect(output).not.toContain("synthetic-token-marker");
    expect(output).not.toContain("synthetic-refresh-marker");
  }
});

it("headless cancellation and lost start replies never retry or expose provider errors", async () => {
  const f = await fixture();
  const args = ["start", "openai-codex", "--method", "browser", "--model", f.model("openai-codex")];
  const login = await f.cli(args);
  const cancelled = await f.cli(["cancel", login.value.sessionId]);
  expect(cancelled).toMatchObject({ exit: 0, value: { state: "cancelled" } });
  expect(cancelled.value).not.toHaveProperty("url");
  let starts = 0;
  const lost = await f.cli(args, async (input, init) => {
    starts++;
    await fetch(input, init);
    throw Error("synthetic-token-marker lost provider reply");
  });
  expect(starts).toBe(1);
  expect(lost).toMatchObject({ exit: 1, value: { ok: false, error: "unavailable" } });
  expect(lost.stdout + lost.stderr).not.toContain("synthetic-token-marker");
  expect((await f.cli(args)).value).toEqual({ ok: false, error: "busy" });
  expect(await f.store.get("openai-codex")).toBeUndefined();
  expect((await f.cli(["status", "not-a-uuid"])).exit).toBe(1);
  const malformed = await f.cli(["methods"], async (input, init) => {
    const response = await fetch(input, init);
    return Response.json({ ...(await response.json()), access_token: "synthetic-token-marker" });
  });
  expect(malformed).toMatchObject({ exit: 1, value: { ok: false, error: "unavailable" } });
  expect(malformed.stdout + malformed.stderr).not.toContain("synthetic-token-marker");
});
