import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileCredentialStore,
  LINEAR_OAUTH_ISSUER,
  LINEAR_API_AUTHORIZE_ENDPOINT,
  resolveProviderBearer,
} from "@clankie/credential-broker";
import { SUPERVISE_GRANTS, TAKE_CONTROL_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
import { writeConvention } from "@clankie/work-items";
import { bodyTelemetryFromEnv } from "@clankie/observability/body-telemetry";
import {
  createAccounts,
  GITHUB_OAUTH_APP_PROVIDER_ID,
  githubConnectionToken,
  oauthAppsFrom,
  type OauthApps,
} from "../src/accounts.ts";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkItemsService } from "../src/work-items.ts";

const logs = vi.hoisted(() => [] as unknown[]);
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

const TOKEN = "gho_MARKER_github_token_never_leaves_7f3a";
const LINEAR_ACCESS = "lin_oauth_MARKER_access_never_leaves_91c2";
const LINEAR_REFRESH = "lin_refresh_MARKER_never_leaves_40bd";
const CLIENT_SECRET = "MARKER_github_app_secret_d81e";

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/**
 * A fake GitHub (device flow, /user, grant revocation, issues) and a fake
 * Linear MCP authorization server, on one loopback port. `device` scripts what
 * the token endpoint answers on each poll; it echoes secrets in its error text
 * to prove none of it is forwarded.
 */
async function fakeProviders(device: string[] = ["authorization_pending", "token"], revokeStatus = 204) {
  const seen: Seen[] = [];
  const issues: Record<string, unknown>[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://fake");
      seen.push({ method: request.method ?? "", path: url.pathname, headers: request.headers, body });
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(value === undefined ? "" : JSON.stringify(value));
      };
      const route = `${request.method} ${url.pathname}`;
      if (route === "POST /login/device/code")
        return json(200, {
          device_code: "device-code-secret",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      if (route === "POST /login/oauth/access_token") {
        const next = device.shift() ?? "authorization_pending";
        if (next === "token") return json(200, { access_token: TOKEN, token_type: "bearer", scope: "repo" });
        return json(200, { error: next, error_description: `echo ${TOKEN}`, interval: 10 });
      }
      if (route === "GET /user")
        return request.headers.authorization === `Bearer ${TOKEN}`
          ? json(200, { login: "octo-owner" })
          : json(401, { message: "Bad credentials" });
      if (request.method === "DELETE" && url.pathname.startsWith("/applications/")) {
        response.writeHead(revokeStatus);
        return response.end();
      }
      if (url.pathname === "/repos/owner/repo/issues") {
        if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: TOKEN });
        if (request.method === "POST") {
          const created = {
            number: issues.length + 1,
            html_url: `https://github.com/owner/repo/issues/${String(issues.length + 1)}`,
            state: "open",
            labels: [],
            ...(JSON.parse(body) as Record<string, unknown>),
          };
          issues.push(created);
          return json(201, created);
        }
        return json(200, issues);
      }
      const issuePath = /^\/repos\/owner\/repo\/issues\/(\d+)$/u.exec(url.pathname);
      if ((request.method === "GET" || request.method === "PATCH") && issuePath) {
        if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: TOKEN });
        const issue = issues.find((entry) => entry.number === Number(issuePath[1]));
        if (issue && request.method === "PATCH") Object.assign(issue, JSON.parse(body));
        return issue ? json(200, issue) : json(404, { message: "Not Found" });
      }
      // Registered API OAuth and the separately retained legacy MCP revoke lane.
      if (route === "POST /linear/register") return json(201, { client_id: "dcr-client" });
      if (route === "POST /linear-api/oauth/token")
        return new URLSearchParams(body).get("code") === "good-code" ||
          new URLSearchParams(body).get("grant_type") === "refresh_token"
          ? json(200, {
              access_token: LINEAR_ACCESS,
              refresh_token: LINEAR_REFRESH,
              expires_in: 3600,
              token_type: "Bearer",
              scope: "read,write",
            })
          : json(400, { error: "invalid_grant", error_description: `echo ${LINEAR_ACCESS}` });
      if (route === "POST /linear-api/graphql")
        return json(200, {
          data: {
            viewer: { id: "app-user", name: "Clankie", app: true },
            organization: { id: "workspace", name: "Personal" },
          },
        });
      if (route === "POST /linear-api/oauth/revoke") return json(200, {});
      if (route === "GET /linear/.well-known/oauth-authorization-server")
        return json(200, { revocation_endpoint: `${LINEAR_OAUTH_ISSUER}/revoke` });
      if (route === "POST /linear/revoke") return json(200, {});
      return json(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`;
  // Linear's endpoints are constants in the broker; route them to the fake.
  const routed: typeof fetch = (input, init) =>
    fetch(
      String(input instanceof Request ? input.url : input)
        .replace(LINEAR_OAUTH_ISSUER, `${origin}/linear`)
        .replace("https://api.linear.app", `${origin}/linear-api`),
      init,
    );
  return {
    origin,
    seen,
    issues,
    fetch: routed,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  logs.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup(
  options: { device?: string[]; apps?: Partial<OauthApps>; secret?: boolean; revokeStatus?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "accounts-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const providers = await fakeProviders(options.device, options.revokeStatus);
  cleanups.push(providers.close);
  const store = new FileCredentialStore(join(dir, "credentials.json"));
  if (options.secret === true)
    await store.set(GITHUB_OAUTH_APP_PROVIDER_ID, { type: "api", key: CLIENT_SECRET });
  let clock = Date.parse("2026-09-26T12:00:00Z");
  const apps: OauthApps = {
    github: { clientId: "Ov23liFakeClient" },
    linear: { clientId: "registered-client", redirectUri: "https://clankie.bot/connect/linear" },
    ...options.apps,
  };
  const accounts = createAccounts({
    store,
    apps: async () => apps,
    fetch: providers.fetch,
    githubWeb: providers.origin,
    githubApi: providers.origin,
    now: () => clock,
  });
  const telemetryDir = join(dir, "telemetry");
  vi.stubEnv("CLANKIE_BODY_TELEMETRY_DIR", telemetryDir);
  bodyTelemetryFromEnv({ CLANKIE_BODY_TELEMETRY_DIR: telemetryDir }, "service")!.emit({
    event: "body.boot",
    phase: "clankie-healthy",
  });
  const app = await createClankieApp({
    captain: createStubCaptain(),
    accounts,
    deviceSessionKey: randomBytes(32),
    eventLogPath: join(dir, "events.jsonl"),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  cleanups.push(() => app.close());
  const call = async (path: string, body?: unknown, token = "owner") => {
    const response = await app.app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  };
  const json = async (path: string, body?: unknown, token?: string) => {
    const { status, text } = await call(path, body, token);
    return { status, body: JSON.parse(text) as Record<string, unknown> };
  };
  const pair = async (acceptedGrants: DeviceGrantSet) => {
    const offer = (await json("/v1/pairing/offer", {})).body as { deepLink: string };
    const pending = (
      await json("/v1/pairing/redeem", {
        offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
        device: { name: "Phone", platform: "ios" },
      })
    ).body;
    const complete = await json("/v1/pairing/complete", {
      completionToken: pending.completionToken,
      acceptedGrants,
    });
    return complete.body.deviceToken as string;
  };
  return {
    dir,
    store,
    providers,
    app: app as ClankieApp,
    call,
    json,
    pair,
    telemetryDir,
    advance: (ms: number) => (clock += ms),
  };
}

describe("GitHub device flow", () => {
  it("connects: user code out, device code and token stay on the body, scopes listed", async () => {
    const { json, store, providers, advance } = await setup();
    expect((await json("/v1/accounts")).body).toEqual({
      connections: [
        { provider: "github", status: "not_connected", scopes: [] },
        { provider: "linear", status: "not_connected", scopes: [] },
      ],
    });
    const start = await json("/v1/accounts/github/start", {});
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({
      ok: true,
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      interval: 5,
    });
    expect(JSON.stringify(start.body)).not.toContain("device-code-secret");
    const flowId = start.body.flowId as string;

    expect((await json("/v1/accounts/github/poll", { flowId })).body).toEqual({
      ok: true,
      status: "pending",
      interval: 5,
    });
    // Polling again inside the interval never reaches GitHub.
    const tokenCalls = () =>
      providers.seen.filter((entry) => entry.path === "/login/oauth/access_token").length;
    expect((await json("/v1/accounts/github/poll", { flowId })).body.status).toBe("pending");
    expect(tokenCalls()).toBe(1);
    advance(5_000);
    const done = await json("/v1/accounts/github/poll", { flowId });
    expect(done.body).toEqual({
      ok: true,
      status: "connected",
      connection: {
        provider: "github",
        status: "connected",
        account: "octo-owner",
        scopes: ["repo"],
        connectedAt: "2026-09-26T12:00:05.000Z",
        manageUrl: "https://github.com/settings/connections/applications/Ov23liFakeClient",
      },
    });
    expect(await githubConnectionToken(store)).toBe(TOKEN);
    const deviceRequest = providers.seen.find((entry) => entry.path === "/login/device/code")!;
    expect(Object.fromEntries(new URLSearchParams(deviceRequest.body))).toEqual({
      client_id: "Ov23liFakeClient",
      scope: "repo",
    });
    expect((await json("/v1/accounts/github/poll", { flowId })).body).toEqual({
      ok: false,
      error: "unknown_flow",
    });
  });

  it("reports an expired code, from GitHub or from the flow's own clock", async () => {
    const fromGithub = await setup({ device: ["expired_token"] });
    const flowId = (await fromGithub.json("/v1/accounts/github/start", {})).body.flowId;
    expect(await fromGithub.json("/v1/accounts/github/poll", { flowId })).toEqual({
      status: 400,
      body: { ok: false, error: "expired" },
    });
    expect(await fromGithub.store.get("github")).toBeUndefined();

    const local = await setup();
    const localFlow = (await local.json("/v1/accounts/github/start", {})).body.flowId;
    local.advance(901_000);
    expect((await local.json("/v1/accounts/github/poll", { flowId: localFlow })).body).toEqual({
      ok: false,
      error: "expired",
    });
    expect(local.providers.seen.some((entry) => entry.path === "/login/oauth/access_token")).toBe(false);
  });

  it("reports a denied request and honors slow_down", async () => {
    const { json, store, advance } = await setup({ device: ["slow_down", "access_denied"] });
    const flowId = (await json("/v1/accounts/github/start", {})).body.flowId;
    expect((await json("/v1/accounts/github/poll", { flowId })).body).toEqual({
      ok: true,
      status: "pending",
      interval: 10,
    });
    advance(10_000);
    expect((await json("/v1/accounts/github/poll", { flowId })).body).toEqual({ ok: false, error: "denied" });
    expect(await store.get("github")).toBeUndefined();
  });

  it("disconnect revokes the grant at GitHub with the app secret, then deletes the token", async () => {
    const { json, store, providers, advance } = await setup({ device: ["token"], secret: true });
    const flowId = (await json("/v1/accounts/github/start", {})).body.flowId;
    advance(1);
    expect((await json("/v1/accounts/github/poll", { flowId })).body.status).toBe("connected");
    expect((await json("/v1/accounts/disconnect", { provider: "github" })).body).toEqual({
      ok: true,
      revoked: true,
    });
    const revoke = providers.seen.find((entry) => entry.method === "DELETE")!;
    expect(revoke.path).toBe("/applications/Ov23liFakeClient/grant");
    expect(revoke.headers.authorization).toBe(
      `Basic ${Buffer.from(`Ov23liFakeClient:${CLIENT_SECRET}`).toString("base64")}`,
    );
    expect(JSON.parse(revoke.body)).toEqual({ access_token: TOKEN });
    expect(await store.get("github")).toBeUndefined();
    expect((await json("/v1/accounts")).body.connections).toContainEqual({
      provider: "github",
      status: "not_connected",
      scopes: [],
    });
  });

  it("without the app secret, disconnect still deletes the token and names where to revoke", async () => {
    const { json, store, providers, advance } = await setup({ device: ["token"] });
    const flowId = (await json("/v1/accounts/github/start", {})).body.flowId;
    advance(1);
    await json("/v1/accounts/github/poll", { flowId });
    expect((await json("/v1/accounts/disconnect", { provider: "github" })).body).toEqual({
      ok: true,
      revoked: false,
      manageUrl: "https://github.com/settings/connections/applications/Ov23liFakeClient",
    });
    expect(providers.seen.some((entry) => entry.method === "DELETE")).toBe(false);
    expect(await store.get("github")).toBeUndefined();
  });

  it("is unconfigured until the owner sets a client ID; the environment wins over settings", async () => {
    const { json } = await setup({ apps: { github: {} } });
    expect((await json("/v1/accounts")).body.connections).toContainEqual({
      provider: "github",
      status: "unconfigured",
      scopes: [],
    });
    expect(await json("/v1/accounts/github/start", {})).toEqual({
      status: 400,
      body: { ok: false, error: "unconfigured" },
    });
    expect(
      oauthAppsFrom(
        { github: { clientId: "from-settings" }, linear: {} },
        { CLANKIE_GITHUB_OAUTH_CLIENT_ID: "from-env" },
      ).github.clientId,
    ).toBe("from-env");
  });
});

it.each([404, 422, 429])("does not claim GitHub revocation for HTTP %i", async (revokeStatus) => {
  const { json, store, providers } = await setup({ device: ["token"], secret: true, revokeStatus });
  const flowId = (await json("/v1/accounts/github/start", {})).body.flowId;
  await json("/v1/accounts/github/poll", { flowId });
  expect((await json("/v1/accounts/disconnect", { provider: "github" })).body).toMatchObject({
    ok: true,
    revoked: false,
    manageUrl: expect.any(String),
  });
  expect(providers.seen.some((entry) => entry.method === "DELETE")).toBe(true);
  expect(await store.get("github")).toBeUndefined();
});
it("refuses a revocation secret belonging to another registered GitHub app", async () => {
  const { json, store, providers } = await setup({ device: ["token"], secret: true });
  await store.set(GITHUB_OAUTH_APP_PROVIDER_ID, {
    type: "api",
    key: CLIENT_SECRET,
    metadata: { clientId: "different-app" },
  });
  const flowId = (await json("/v1/accounts/github/start", {})).body.flowId;
  await json("/v1/accounts/github/poll", { flowId });
  expect((await json("/v1/accounts/disconnect", { provider: "github" })).body.revoked).toBe(false);
  expect(providers.seen.some((entry) => entry.method === "DELETE")).toBe(false);
});

describe("Linear OAuth with PKCE", () => {
  it("keeps the verifier on the body, exchanges once, and revokes on disconnect", async () => {
    const { json, store, providers } = await setup();
    const start = await json("/v1/accounts/linear/start", {});
    expect(start.body).toMatchObject({ ok: true, redirectUri: "https://clankie.bot/connect/linear" });
    const authorize = new URL(start.body.authorizeUrl as string);
    expect(authorize.origin + authorize.pathname).toBe(LINEAR_API_AUTHORIZE_ENDPOINT);
    expect(authorize.searchParams.get("actor")).toBe("app");
    expect(authorize.searchParams.get("scope")).toBe("read,write");
    expect(providers.seen.some((entry) => entry.path.includes("register"))).toBe(false);
    expect(authorize.searchParams.get("client_id")).toBe("registered-client");
    expect(authorize.searchParams.get("state")).toBe(start.body.flowId);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

    const state = start.body.flowId;
    expect((await json("/v1/accounts/linear/complete", { state, code: "good-code" })).body).toEqual({
      ok: true,
      connection: {
        provider: "linear",
        status: "connected",
        scopes: ["read", "write"],
        account: "Clankie",
        actor: "app",
        workspace: "Personal",
        connectedAt: expect.any(String),
        manageUrl: "https://linear.app/settings/api",
      },
    });
    const exchange = new URLSearchParams(
      providers.seen.find((entry) => entry.path === "/linear-api/oauth/token")!.body,
    );
    expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
    expect(JSON.stringify(start.body)).not.toContain(exchange.get("code_verifier")!);
    expect(await store.get("linear-api")).toMatchObject({
      type: "oauth",
      linearAuth: "api",
      access: LINEAR_ACCESS,
      metadata: { scopes: "read,write" },
      account: { actor: "app" },
    });
    expect(await store.get("linear")).toBeUndefined();
    // The redirect cannot be replayed.
    expect((await json("/v1/accounts/linear/complete", { state, code: "good-code" })).body).toEqual({
      ok: false,
      error: "unknown_flow",
    });

    expect((await json("/v1/accounts/disconnect", { provider: "linear" })).body).toEqual({
      ok: true,
      revoked: true,
    });
    const revoke = new URLSearchParams(
      providers.seen.find((entry) => entry.path === "/linear-api/oauth/revoke")!.body,
    );
    expect(Object.fromEntries(revoke)).toEqual({
      token: LINEAR_REFRESH,
      token_type_hint: "refresh_token",
    });
    expect(await store.get("linear-api")).toBeUndefined();
    expect(await store.get("linear")).toBeUndefined();
  });

  it("rejects a bad code without echoing Linear's error and is unconfigured without a redirect", async () => {
    const { json } = await setup();
    const state = (await json("/v1/accounts/linear/start", {})).body.flowId;
    expect(await json("/v1/accounts/linear/complete", { state, code: "bad-code" })).toEqual({
      status: 400,
      body: { ok: false, error: "provider_rejected" },
    });
    const bare = await setup({ apps: { linear: {} } });
    expect((await bare.json("/v1/accounts/linear/start", {})).body).toEqual({
      ok: false,
      error: "unconfigured",
    });
  });
});

describe("registered Linear broker boundaries", () => {
  it("cancels unexchanged flows without claiming a provider grant was revoked", async () => {
    const { json, store, providers } = await setup();
    const state = (await json("/v1/accounts/linear/start", {})).body.flowId;
    expect((await json("/v1/accounts/disconnect", { provider: "linear" })).body).toMatchObject({
      ok: true,
      revoked: false,
    });
    expect((await json("/v1/accounts/linear/complete", { state, code: "good-code" })).body.error).toBe(
      "unknown_flow",
    );
    expect(
      providers.seen.some((entry) => entry.path.includes("revoke") || entry.path.includes("token")),
    ).toBe(false);
    expect(await store.get("linear-api")).toBeUndefined();
  });

  it("refreshes only the API audience and deletes both Linear lanes and pending flows", async () => {
    const { json, store, providers } = await setup();
    const state = (await json("/v1/accounts/linear/start", {})).body.flowId;
    await json("/v1/accounts/linear/complete", { state, code: "good-code" });
    const api = await store.get("linear-api");
    if (api?.type !== "oauth") throw new Error("Expected API credential");
    await store.set("linear-api", { ...api, expires: Date.now() - 1 });
    await store.set("linear", { type: "api", key: "legacy-personal-api-key" });
    expect(await resolveProviderBearer("linear-api", store, Date.now(), { fetch: providers.fetch })).toBe(
      LINEAR_ACCESS,
    );
    expect(
      providers.seen
        .filter((entry) => entry.path === "/linear-api/oauth/token")
        .map((entry) => new URLSearchParams(entry.body).get("grant_type")),
    ).toEqual(["authorization_code", "refresh_token"]);
    expect(await resolveProviderBearer("linear", store)).toBe("legacy-personal-api-key");
    const older = (await json("/v1/accounts/linear/start", {})).body.flowId;
    expect((await json("/v1/accounts/disconnect", { provider: "linear" })).body).toMatchObject({
      ok: true,
      revoked: false,
      manageUrl: expect.any(String),
    });
    expect(await store.get("linear-api")).toBeUndefined();
    expect(await store.get("linear")).toBeUndefined();
    expect((await json("/v1/accounts/linear/complete", { state: older, code: "good-code" })).body.error).toBe(
      "unknown_flow",
    );
    // An API token mistakenly written to the legacy id fails closed before any network.
    await store.set("linear", api);
    await expect(resolveProviderBearer("linear", store)).rejects.toThrow("cannot authenticate MCP");
  });
});

describe("authority and redaction", () => {
  it("requires the owner or a Take Control device", async () => {
    const { json, pair } = await setup();
    const supervise = await pair(SUPERVISE_GRANTS);
    const control = await pair(TAKE_CONTROL_GRANTS);
    expect((await json("/v1/accounts", undefined, "nobody")).status).toBe(401);
    expect((await json("/v1/accounts/github/start", {}, supervise)).status).toBe(403);
    expect((await json("/v1/accounts/disconnect", { provider: "github" }, supervise)).status).toBe(403);
    expect((await json("/v1/accounts/github/start", {}, control)).status).toBe(200);
    expect((await json("/v1/accounts/github/start", { extra: 1 }, "owner")).status).toBe(200);
    expect((await json("/v1/accounts/disconnect", { provider: "gitlab" })).body).toEqual({
      ok: false,
      error: "malformed",
    });
  });

  it("never lets a token reach responses, body logs, the event log, telemetry or stderr", async () => {
    const { call, json, store, dir, telemetryDir, advance } = await setup({
      device: ["authorization_pending", "incorrect_device_code"],
      secret: true,
    });
    const output: string[] = [];
    const stderr = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => output.push(JSON.stringify(args)));
    // Errors that echo the token, a failed start, then a real connection.
    let flowId = (await json("/v1/accounts/github/start", {})).body.flowId;
    output.push((await call("/v1/accounts/github/poll", { flowId })).text);
    advance(5_000);
    output.push((await call("/v1/accounts/github/poll", { flowId })).text);
    await store.set("github", { type: "api", key: TOKEN, metadata: { scopes: "repo", login: "octo-owner" } });
    output.push((await call("/v1/accounts")).text);
    const state = (await json("/v1/accounts/linear/start", {})).body.flowId;
    output.push((await call("/v1/accounts/linear/complete", { state, code: "bad-code" })).text);
    const good = (await json("/v1/accounts/linear/start", {})).body.flowId;
    output.push((await call("/v1/accounts/linear/complete", { state: good, code: "good-code" })).text);
    output.push((await call("/v1/accounts")).text);
    vi.spyOn(store, "get").mockRejectedValueOnce(new Error(`broker echoed ${TOKEN}`));
    output.push((await call("/v1/accounts")).text);
    output.push((await call("/v1/accounts/disconnect", { provider: "github" })).text);
    output.push((await call("/v1/accounts/disconnect", { provider: "linear" })).text);
    flowId = "x".repeat(20);
    output.push((await call("/v1/accounts/github/poll", { flowId, token: TOKEN })).text);
    output.push(JSON.stringify(logs), await readFile(join(dir, "events.jsonl"), "utf8").catch(() => ""));
    for (const file of await readdir(telemetryDir))
      output.push(await readFile(join(telemetryDir, file), "utf8"));
    const everything = output.join("\n");
    for (const secret of [TOKEN, LINEAR_ACCESS, LINEAR_REFRESH, CLIENT_SECRET, "device-code-secret"])
      expect(everything).not.toContain(secret);
    expect(everything).toContain('"status":"connected"');
    expect(everything).toContain("provider_rejected");
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("work tracker on a hosted body", () => {
  const trackerSetup = async (token: string | undefined) => {
    const { dir, providers } = await setup();
    const repo = join(dir, "repo");
    await writeConvention(repo, {
      schemaVersion: 1,
      backend: "github",
      github: { repo: "owner/repo" },
      decidedBy: "owner",
      decidedAt: "2026-09-26T12:00:00Z",
    });
    const gh = vi.fn(async () => {
      throw new Error("a hosted body never runs gh");
    });
    const service = createWorkItemsService({
      stateDirectory: dir,
      workspace: () => repo,
      githubToken: async () => token,
      hosted: true,
      gh,
      fetch,
      githubApiBase: providers.origin,
    });
    return { service, providers, gh };
  };

  it("uses the GitHub connection token against the REST API", async () => {
    const { service, providers, gh } = await trackerSetup(TOKEN);
    const created = await service.handle(
      {
        action: "create",
        repo: "workspace",
        title: "Connect accounts",
        criteria: ["Tokens stay on the body"],
      },
      true,
    );
    expect(created).toMatchObject({ item: { id: "#1", title: "Connect accounts", status: "todo" } });
    const listed = await service.handle({ action: "list", repo: "workspace" }, false);
    expect(listed).toMatchObject({
      items: [{ id: "#1", criteria: [{ text: "Tokens stay on the body", done: false }] }],
    });
    expect(gh).not.toHaveBeenCalled();
    expect(
      providers.seen
        .filter((entry) => entry.path === "/repos/owner/repo/issues")
        .map((entry) => entry.headers.authorization),
    ).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it("says to connect GitHub when the body has no connection", async () => {
    const { service, gh } = await trackerSetup(undefined);
    const failure = await service
      .handle({ action: "list", repo: "workspace" }, false)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      name: "BackendUnavailableError",
      message: "This repo tracks work in GitHub issues (owner/repo); connect GitHub to Clankie to use it",
    });
    expect(gh).not.toHaveBeenCalled();
  });
});
