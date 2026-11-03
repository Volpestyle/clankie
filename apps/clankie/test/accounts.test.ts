import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
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
  CLANKIE_GITHUB_APP,
  createAccounts,
  GITHUB_OAUTH_APP_PROVIDER_ID,
  githubConnection,
  githubConnectionToken,
  oauthAppsFrom,
  type OauthApps,
} from "../src/accounts.ts";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkItemsService } from "../src/work-items.ts";

const TOKEN = "gho_MARKER_github_token_never_leaves_7f3a";
const OTHER_BODY_TOKEN = "gho_MARKER_other_body_token_stays_valid_b47c";
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
  const validTokens = new Set([TOKEN, OTHER_BODY_TOKEN]);
  // A GitHub App client (`Iv…`) gets expiring user tokens; each refresh rotates both.
  const app = { generation: 0, refresh: "", down: false };
  const appPair = () => {
    app.generation += 1;
    const access = `ghu_MARKER_app_access_${String(app.generation)}`;
    app.refresh = `ghr_MARKER_app_refresh_${String(app.generation)}`;
    for (const token of validTokens) if (token.startsWith("ghu_")) validTokens.delete(token);
    validTokens.add(access);
    return {
      access_token: access,
      expires_in: 28_800,
      refresh_token: app.refresh,
      refresh_token_expires_in: 15_897_600,
      token_type: "bearer",
      scope: "",
    };
  };
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
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "refresh_token") {
          if (app.down) return json(502, { message: "unavailable" });
          if (form.get("refresh_token") !== app.refresh || app.refresh === "")
            return json(200, { error: "bad_refresh_token", error_description: `echo ${app.refresh}` });
          return json(200, appPair());
        }
        const next = device.shift() ?? "authorization_pending";
        if (next === "token" && form.get("client_id")?.startsWith("Iv")) return json(200, appPair());
        if (next === "token") return json(200, { access_token: TOKEN, token_type: "bearer", scope: "repo" });
        return json(200, { error: next, error_description: `echo ${TOKEN}`, interval: 10 });
      }
      if (route === "GET /user")
        return validTokens.has((request.headers.authorization ?? "").replace(/^Bearer /u, ""))
          ? json(200, { login: "octo-owner" })
          : json(401, { message: "Bad credentials" });
      if (request.method === "DELETE" && url.pathname.startsWith("/applications/")) {
        if (revokeStatus === 204) {
          if (url.pathname.endsWith("/token"))
            validTokens.delete(String((JSON.parse(body) as { access_token: string }).access_token));
          else if (url.pathname.endsWith("/grant")) validTokens.clear();
          else return json(404, {});
        }
        response.writeHead(revokeStatus);
        return response.end();
      }
      // The app is not installed on this repository: GitHub refuses its user token's writes.
      if (url.pathname === "/repos/owner/uninstalled/issues")
        return request.method === "GET"
          ? json(200, [])
          : json(403, { message: "Resource not accessible by integration" });
      if (url.pathname === "/repos/owner/repo/issues") {
        const bearer = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
        if (bearer !== TOKEN && !(bearer.startsWith("ghu_") && validTokens.has(bearer)))
          return json(401, { message: TOKEN });
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
        const bearer = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
        if (bearer !== TOKEN && !(bearer.startsWith("ghu_") && validTokens.has(bearer)))
          return json(401, { message: TOKEN });
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
    app,
    fetch: routed,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup(
  options: {
    device?: string[];
    apps?: Partial<OauthApps>;
    secret?: boolean;
    revokeStatus?: number;
    hosted?: boolean;
  } = {},
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
    ...(options.hosted === undefined ? {} : { hosted: options.hosted }),
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
    now: () => clock,
    advance: (ms: number) => (clock += ms),
  };
}

describe("GitHub device flow", () => {
  it("connects: user code out, device code and token stay on the body, scopes listed", async () => {
    const { json, store, providers, advance } = await setup();
    expect((await json("/v1/accounts")).body).toMatchObject({
      connections: [
        { provider: "github", status: "not_connected", scopes: [] },
        { provider: "linear", status: "not_connected", scopes: [] },
        { provider: "google-gmail", status: "unconfigured", scopes: [] },
        { provider: "google-calendar", status: "unconfigured", scopes: [] },
        { provider: "google-drive", status: "unconfigured", scopes: [] },
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

  it("disconnect revokes this token at GitHub with the owner app secret, then deletes the token", async () => {
    const { json, store, providers, advance } = await setup({ device: ["token"], secret: true });
    const flowId = (await json("/v1/accounts/github/start", {})).body.flowId;
    advance(1);
    expect((await json("/v1/accounts/github/poll", { flowId })).body.status).toBe("connected");
    expect((await json("/v1/accounts/disconnect", { provider: "github" })).body).toEqual({
      ok: true,
      revoked: true,
    });
    const revoke = providers.seen.find((entry) => entry.method === "DELETE")!;
    expect(revoke.path).toBe("/applications/Ov23liFakeClient/token");
    expect(revoke.headers.authorization).toBe(
      `Basic ${Buffer.from(`Ov23liFakeClient:${CLIENT_SECRET}`).toString("base64")}`,
    );
    expect(JSON.parse(revoke.body)).toEqual({ access_token: TOKEN });
    expect(await store.get("github")).toBeUndefined();
    expect((await json("/v1/accounts")).body.connections).toContainEqual(
      expect.objectContaining({
        provider: "github",
        status: "not_connected",
        scopes: [],
      }),
    );
  });

  it("revokes only this self-hosted body's token and preserves another body's token for the same app/account", async () => {
    const { json, store, providers, dir } = await setup({ device: ["token"], secret: true });
    const secondStore = new FileCredentialStore(join(dir, "other-body-credentials.json"));
    await secondStore.set("github", {
      type: "api",
      key: OTHER_BODY_TOKEN,
      metadata: { clientId: "Ov23liFakeClient", login: "octo-owner", scopes: "repo" },
    });
    const flowId = (await json("/v1/accounts/github/start", {})).body.flowId;
    await json("/v1/accounts/github/poll", { flowId });
    expect(
      (await fetch(`${providers.origin}/user`, { headers: { authorization: `Bearer ${OTHER_BODY_TOKEN}` } }))
        .status,
    ).toBe(200);
    expect((await json("/v1/accounts/disconnect", { provider: "github" })).body).toEqual({
      ok: true,
      revoked: true,
    });
    expect(
      (await fetch(`${providers.origin}/user`, { headers: { authorization: `Bearer ${TOKEN}` } })).status,
    ).toBe(401);
    expect(
      (await fetch(`${providers.origin}/user`, { headers: { authorization: `Bearer ${OTHER_BODY_TOKEN}` } }))
        .status,
    ).toBe(200);
    expect(await githubConnectionToken(secondStore)).toBe(OTHER_BODY_TOKEN);
    expect(await store.get("github")).toBeUndefined();
    expect(providers.seen.filter((entry) => entry.method === "DELETE").map((entry) => entry.path)).toEqual([
      "/applications/Ov23liFakeClient/token",
    ]);
  });

  it("hosted disconnect ignores an accidentally present developer secret and preserves the remote token", async () => {
    const { json, store, providers } = await setup({ device: ["token"], secret: true, hosted: true });
    const flowId = (await json("/v1/accounts/github/start", {})).body.flowId;
    await json("/v1/accounts/github/poll", { flowId });
    const reads = vi.spyOn(store, "get");
    expect((await json("/v1/accounts/disconnect", { provider: "github" })).body).toEqual({
      ok: true,
      revoked: false,
      manageUrl: "https://github.com/settings/connections/applications/Ov23liFakeClient",
    });
    expect(reads.mock.calls.some(([id]) => id === GITHUB_OAUTH_APP_PROVIDER_ID)).toBe(false);
    expect(providers.seen.some((entry) => entry.method === "DELETE")).toBe(false);
    expect(await store.get("github")).toBeUndefined();
    expect(
      (await fetch(`${providers.origin}/user`, { headers: { authorization: `Bearer ${TOKEN}` } })).status,
    ).toBe(200);
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
    expect((await json("/v1/accounts")).body.connections).toContainEqual(
      expect.objectContaining({
        provider: "github",
        status: "unconfigured",
        scopes: [],
      }),
    );
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

  it("keeps credentials out of nonempty real body stdout, responses, events and telemetry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "accounts-real-pino-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const providers = await fakeProviders(["authorization_pending", "incorrect_device_code", "token"]);
    cleanups.push(providers.close);
    const modulePath = (relative: string) =>
      JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)));
    // A separate process captures the actual Pino fd1 destination, not a mocked logger.
    // Provider and body both use real localhost HTTP; the broker/events/spool use real files.
    const script = `
      import { randomBytes } from 'node:crypto';
      import { join } from 'node:path';
      import { serve } from '@hono/node-server';
      import { FileCredentialStore } from '@clankie/credential-broker';
      import { bodyTelemetryFromEnv } from '@clankie/observability/body-telemetry';
      import { createAccounts } from ${modulePath("../src/accounts.ts")};
      import { createClankieApp } from ${modulePath("../src/app.ts")};
      import { createStubCaptain } from ${modulePath("../src/captain/port.ts")};
      const dir = ${JSON.stringify(dir)};
      const origin = ${JSON.stringify(providers.origin)};
      const store = new FileCredentialStore(join(dir, 'credentials.json'));
      await store.set('github-oauth-app', { type:'api', key:${JSON.stringify(CLIENT_SECRET)}, metadata:{clientId:'Ov23liFakeClient'} });
      let clock = Date.parse('2026-10-05T02:00:00Z');
      const providerFetch = (input, init) => fetch(String(input instanceof Request ? input.url : input).replace('https://api.linear.app', origin+'/linear-api').replace('https://mcp.linear.app', origin+'/linear'), init);
      const accounts = createAccounts({ store, hosted:false, apps: async()=>({github:{clientId:'Ov23liFakeClient'}, linear:{clientId:'registered-client',redirectUri:'https://clankie.bot/connect/linear'}}), fetch:providerFetch, githubWeb:origin, githubApi:origin, now:()=>clock });
      const body = await createClankieApp({ captain:createStubCaptain(), accounts, deviceSessionKey:randomBytes(32), eventLogPath:join(dir,'events.jsonl'), authenticateOperator:async(request)=>request.headers.get('authorization')==='Bearer owner'?{operatorId:'owner'}:undefined });
      const telemetry = bodyTelemetryFromEnv(process.env, 'service');
      telemetry.emit({event:'body.boot',phase:'clankie-healthy'});
      let server;
      const address = await new Promise((resolve)=>{server=serve({fetch:body.app.fetch,hostname:'127.0.0.1',port:0},resolve)});
      const url = 'http://127.0.0.1:'+address.port;
      const responses = [];
      const call = async(path, input)=> {
        const response = await fetch(url+path,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer owner','content-type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
        const text = await response.text(); responses.push({path,status:response.status,text}); return JSON.parse(text);
      };
      try {
        await call('/v1/pairing/offer',{});
        let flow = await call('/v1/accounts/github/start',{});
        await call('/v1/accounts/github/poll',{flowId:flow.flowId});
        clock += 5000;
        await call('/v1/accounts/github/poll',{flowId:flow.flowId});
        flow = await call('/v1/accounts/github/start',{});
        await call('/v1/accounts/github/poll',{flowId:flow.flowId});
        const bad = await call('/v1/accounts/linear/start',{});
        await call('/v1/accounts/linear/complete',{state:bad.flowId,code:'bad-code'});
        const good = await call('/v1/accounts/linear/start',{});
        await call('/v1/accounts/linear/complete',{state:good.flowId,code:'good-code'});
        await call('/v1/accounts');
        await call('/v1/accounts/github/poll',{flowId:'x'.repeat(20),token:${JSON.stringify(TOKEN)}});
        await call('/v1/accounts/disconnect',{provider:'github'});
        await call('/v1/accounts/disconnect',{provider:'linear'});
        telemetry.emit({event:'body.shutdown',reason:'test_completed'});
        process.stdout.write(JSON.stringify({fixture:'responses',responses})+'\\n');
      } finally { await body.close(); await new Promise((resolve)=>server.close(resolve)); }
    `;
    const child = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx/esm"), "--input-type=module", "--eval", script],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: {
          PATH: process.env.PATH,
          HOME: join(dir, "home"),
          XDG_CONFIG_HOME: join(dir, "config"),
          XDG_DATA_HOME: join(dir, "data"),
          XDG_STATE_HOME: join(dir, "state"),
          CLANKIE_LOG_LEVEL: "info",
          CLANKIE_BODY_TELEMETRY_DIR: join(dir, "telemetry"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const lines = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const bodyLogs = lines.filter((line) => line.service === "clankie");
    expect(bodyLogs.length).toBeGreaterThan(0);
    expect(bodyLogs).toContainEqual(
      expect.objectContaining({ msg: "pairing offer minted", operatorId: "owner" }),
    );
    const responseCapture = lines.find((line) => line.fixture === "responses")!;
    expect(Array.isArray(responseCapture.responses)).toBe(true);
    const responses = responseCapture.responses as Array<{ path: string; status: number; text: string }>;
    expect(responses.length).toBeGreaterThan(10);
    expect(responses).toContainEqual(
      expect.objectContaining({
        path: "/v1/accounts/linear/complete",
        status: 400,
        text: JSON.stringify({ ok: false, error: "provider_rejected" }),
      }),
    );
    expect(
      responses.some(
        (response) => response.path === "/v1/accounts" && response.text.includes('"status":"connected"'),
      ),
    ).toBe(true);
    const events = await readFile(join(dir, "events.jsonl"), "utf8");
    expect(events.trim()).not.toBe("");
    expect(events).toContain('"type":"pairing.offer.minted"');
    const spoolFiles = await readdir(join(dir, "telemetry"));
    expect(spoolFiles.length).toBeGreaterThan(0);
    const telemetry = (
      await Promise.all(spoolFiles.map((file) => readFile(join(dir, "telemetry", file), "utf8")))
    ).join("\n");
    expect(telemetry.trim()).not.toBe("");
    expect(telemetry).toContain('"event":"body.boot"');
    expect(telemetry).toContain('"event":"body.shutdown"');
    const everything = [stdout, stderr, events, telemetry].join("\n");
    for (const secret of [TOKEN, LINEAR_ACCESS, LINEAR_REFRESH, CLIENT_SECRET, "device-code-secret"])
      expect(everything).not.toContain(secret);
    expect(
      providers.seen.some(
        (entry) =>
          entry.path === "/linear-api/oauth/token" &&
          new URLSearchParams(entry.body).get("code") === "bad-code",
      ),
    ).toBe(true);
    expect(providers.seen.some((entry) => entry.path === "/login/oauth/access_token")).toBe(true);
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
      name: "WorkRequestError",
      code: "backend_unavailable",
      message: "This repo tracks work in GitHub issues (owner/repo); connect GitHub to Clankie to use it",
    });
    expect(gh).not.toHaveBeenCalled();
  });
});

describe("GitHub App user tokens (#185)", () => {
  const EIGHT_HOURS = 28_800_000;
  const connectApp = async (clientId = "Iv23liFakeApp") => {
    const context = await setup({ device: ["token"], apps: { github: { clientId } } });
    const flowId = (await context.json("/v1/accounts/github/start", {})).body.flowId;
    context.advance(1);
    const polled = await context.json("/v1/accounts/github/poll", { flowId });
    // Always the fake GitHub and the test clock: a real clock would see the token as expired.
    const github = { fetch: context.providers.fetch, githubWeb: context.providers.origin, now: context.now };
    const token = () => githubConnectionToken(context.store, github);
    const connection = () => githubConnection(context.store, github);
    const refreshes = () =>
      context.providers.seen.filter(
        (entry) =>
          entry.path === "/login/oauth/access_token" &&
          new URLSearchParams(entry.body).get("grant_type") === "refresh_token",
      );
    return { ...context, polled, github, token, connection, refreshes };
  };

  it("connects without the repo scope and keeps the rotating pair on the body", async () => {
    const { polled, providers, store, json, token, refreshes, now } = await connectApp();
    const deviceRequest = providers.seen.find((entry) => entry.path === "/login/device/code")!;
    expect(Object.fromEntries(new URLSearchParams(deviceRequest.body))).toEqual({
      client_id: "Iv23liFakeApp",
    });
    expect(polled.body).toMatchObject({
      ok: true,
      status: "connected",
      connection: { provider: "github", status: "connected", account: "octo-owner", scopes: [] },
    });
    const stored = await store.get("github");
    expect(stored).toMatchObject({
      type: "oauth",
      access: "ghu_MARKER_app_access_1",
      refresh: "ghr_MARKER_app_refresh_1",
      expires: now() + EIGHT_HOURS,
      clientId: "Iv23liFakeApp",
    });
    const listed = await json("/v1/accounts");
    expect(listed.body.connections).toContainEqual(
      expect.objectContaining({
        provider: "github",
        status: "connected",
        access: "Read and write issues in repositories where the GitHub App is installed.",
      }),
    );
    expect(JSON.stringify([polled.body, listed.body])).not.toMatch(/gh[ur]_MARKER/u);
    expect(await token()).toBe("ghu_MARKER_app_access_1");
    expect(refreshes()).toHaveLength(0);
  });

  it("refreshes before the 8-hour expiry once for concurrent callers, keeping the account binding", async () => {
    const { store, token, connection, refreshes, advance, providers } = await connectApp();
    const before = await connection();
    expect(before?.binding).toMatch(/^github-connection:/u);
    advance(EIGHT_HOURS - 4 * 60_000);
    expect(await Promise.all([token(), token(), token()])).toEqual([
      "ghu_MARKER_app_access_2",
      "ghu_MARKER_app_access_2",
      "ghu_MARKER_app_access_2",
    ]);
    expect(refreshes()).toHaveLength(1);
    // A device-flow token refreshes with no client secret.
    expect(Object.fromEntries(new URLSearchParams(refreshes()[0]!.body))).toEqual({
      client_id: "Iv23liFakeApp",
      grant_type: "refresh_token",
      refresh_token: "ghr_MARKER_app_refresh_1",
    });
    expect(await store.get("github")).toMatchObject({ refresh: "ghr_MARKER_app_refresh_2" });
    expect((await connection())?.binding).toBe(before?.binding);
    // The refreshed token works against the API; the rotated-out one does not.
    const user = async (bearer: string) =>
      (await fetch(`${providers.origin}/user`, { headers: { authorization: `Bearer ${bearer}` } })).status;
    expect(await user("ghu_MARKER_app_access_2")).toBe(200);
    expect(await user("ghu_MARKER_app_access_1")).toBe(401);
  });

  it("keeps a valid token while GitHub is unreachable and asks for a reconnect once refresh is refused", async () => {
    const { providers, token, refreshes, advance, json } = await connectApp();
    providers.app.down = true;
    advance(EIGHT_HOURS - 60_000);
    expect(await token()).toBe("ghu_MARKER_app_access_1");
    advance(2 * 60_000);
    await expect(token()).rejects.toThrow("GitHub is unavailable to refresh");
    providers.app.down = false;
    providers.app.refresh = "ghr_revoked_elsewhere";
    expect(await token()).toBeUndefined();
    const attempts = refreshes().length;
    expect(await token()).toBeUndefined();
    expect(refreshes()).toHaveLength(attempts);
    expect((await json("/v1/accounts")).body.connections).toContainEqual(
      expect.objectContaining({ provider: "github", status: "reconnect_required", reason: "invalid_grant" }),
    );
  });

  it("defaults to Clankie's app, keeps an owner's own client id, and names the install page on a refused write", async () => {
    expect(oauthAppsFrom({}, {}).github.clientId).toBeUndefined();
    const original = { ...CLANKIE_GITHUB_APP };
    Object.assign(CLANKIE_GITHUB_APP, { clientId: "Iv23liClankieApp", slug: "clankie-test" });
    cleanups.push(() => Object.assign(CLANKIE_GITHUB_APP, original));
    expect(oauthAppsFrom({}, {}).github.clientId).toBe("Iv23liClankieApp");
    expect(oauthAppsFrom({ github: { clientId: "Ov23liOwnersOwn" } }, {}).github.clientId).toBe(
      "Ov23liOwnersOwn",
    );

    const own = await connectApp("Iv23liOwnersApp");
    expect((await own.connection())?.installUrl).toBeUndefined();

    const { dir, providers, connection } = await connectApp(oauthAppsFrom({}, {}).github.clientId);
    expect((await connection())?.installUrl).toBe("https://github.com/apps/clankie-test/installations/new");
    const repo = join(dir, "uninstalled");
    await writeConvention(repo, {
      schemaVersion: 1,
      backend: "github",
      github: { repo: "owner/uninstalled" },
      decidedBy: "owner",
      decidedAt: "2026-09-26T12:00:00Z",
    });
    const service = createWorkItemsService({
      stateDirectory: dir,
      workspace: () => repo,
      githubConnection: connection,
      hosted: true,
      gh: async () => {
        throw new Error("a hosted body never runs gh");
      },
      fetch,
      githubApiBase: providers.origin,
    });
    const failure = await service
      .handle({ action: "create", repo: "workspace", title: "Needs the app", criteria: ["Installed"] }, true)
      .catch((error: unknown) => error);
    expect(String((failure as Error).message)).toContain(
      "If the Clankie GitHub App is not installed on this repository, install it: https://github.com/apps/clankie-test/installations/new",
    );
  });

  it("refuses an owner write when the owner's authority is revoked during any GitHub credential read", async () => {
    const { dir, store, providers, github } = await connectApp();
    const repo = join(await realpath(dir), "owner-write");
    await writeConvention(repo, {
      schemaVersion: 1,
      backend: "github",
      github: { repo: "owner/repo" },
      decidedBy: "owner",
      decidedAt: "2026-09-26T12:00:00Z",
    });
    // Revokes the owner's authority during the Nth read of the GitHub connection.
    let reads = 0;
    let revokeAt = Number.POSITIVE_INFINITY;
    let revoked = false;
    const counted = {
      get: async (id: string) => {
        const value = await store.get(id);
        if (id === "github" && ++reads === revokeAt) revoked = true;
        return value;
      },
      update: store.update.bind(store),
    };
    const service = createWorkItemsService({
      stateDirectory: join(dir, "owner-state"),
      workspace: () => repo,
      githubConnection: () => githubConnection(counted, github),
      hosted: true,
      gh: async () => {
        throw new Error("a hosted body never runs gh");
      },
      fetch,
      githubApiBase: providers.origin,
    });
    await service.handle(
      { action: "create", repo: "workspace", title: "Owner write", criteria: ["Labelled"] },
      true,
    );
    const authority = {
      principal: { kind: "operator" as const, id: "owner" },
      authorize: async () => !revoked,
      current: () => !revoked,
    };
    const writes = () =>
      providers.seen.filter((entry) => entry.method !== "GET" && entry.path === "/repos/owner/repo/issues/1")
        .length;
    const write = (at: number) => {
      reads = 0;
      revokeAt = at;
      revoked = false;
      return service.handleOwnerWrite(
        {
          repoId: "workspace",
          itemId: "#1",
          requestId: randomUUID(),
          command: { action: "add_label", label: `label-${String(at)}` },
        },
        authority,
      );
    };
    // Unrevoked, the write lands; it shows how many connection reads one write makes.
    const applied = await write(Number.POSITIVE_INFINITY);
    expect(applied.outcome).toBe("applied");
    expect(writes()).toBe(1);
    const total = reads;
    expect(total).toBeGreaterThan(1);
    for (let at = 1; at <= total; at += 1) {
      const outcome = await write(at).then(
        (receipt) => receipt.outcome,
        () => "threw",
      );
      expect({ at, revoked, outcome, writes: writes() }).toEqual({
        at,
        revoked: true,
        outcome: expect.not.stringMatching(/^applied$/u),
        writes: 1,
      });
    }
  });
});
