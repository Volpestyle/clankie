import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  CLANKIE_ACCOUNT_PROVIDER_ID,
  createClankieAccountTokenProvider,
  derivePublicGatewayHostId,
  FileCredentialStore,
} from "@clankie/credential-broker";
import { TAKE_CONTROL_GRANTS } from "@clankie/protocol";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import {
  MAC_ACCOUNT_COMPLETE_PATH,
  MAC_ACCOUNT_PATH,
  MAC_ACCOUNT_START_PATH,
} from "@clankie/protocol/mac-account";
import { publicGatewayTargetFor } from "@clankie/protocol/public-gateway";
import { SettingsStore } from "@clankie/settings";
import { afterEach, describe, expect, it } from "vitest";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { connectBodyToGateway } from "../src/body-doorway.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { LocalCompanionBoundary } from "../src/local-companion-boundary.ts";

const CLIENT_ID = "fixtureclient";
const accessFor = (sub: string) =>
  `h.${Buffer.from(JSON.stringify({ sub, client_id: CLIENT_ID, token_use: "access" })).toString("base64url")}.s`;
const ACCESS = accessFor("account-sub");
const REFRESH = "refresh-token-never-leaves";
const SESSION = "cognito-session-never-leaves";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The public gateway's discovery and Cognito, over real HTTP. */
async function accountService() {
  const account = { access: ACCESS };
  const calls: { target: string; body: Record<string, unknown> }[] = [];
  /** A refresh waits here until the test lets Cognito answer. */
  const refresh = { hold: Promise.resolve(), reached: () => {} };
  const server: Server = createServer((request, response) => {
    if (request.method === "HEAD") {
      response.statusCode = 405;
      response.end();
      return;
    }
    if (request.url === "/gateway/v1/config") {
      const { port } = server.address() as AddressInfo;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          account: {
            provider: "cognito_email_otp",
            endpoint: `http://127.0.0.1:${String(port)}`,
            issuer: "https://cognito-idp.us-east-1.amazonaws.com/fixture",
            clientId: CLIENT_ID,
            selfSignUpEnabled: false,
          },
        }),
      );
      return;
    }
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const target = String(request.headers["x-amz-target"]).split(".").at(-1)!;
      const body = JSON.parse(raw) as Record<string, unknown>;
      calls.push({ target, body });
      const reply = (status: number, value: unknown) => {
        response.statusCode = status;
        response.end(JSON.stringify(value));
      };
      if (target === "GetTokensFromRefreshToken") {
        refresh.reached();
        void refresh.hold.then(() =>
          reply(200, {
            AuthenticationResult: {
              AccessToken: accessFor("old-sub"),
              RefreshToken: "old-rotated",
              ExpiresIn: 3600,
            },
          }),
        );
        return;
      }
      if (target === "InitiateAuth") {
        const email = (body.AuthParameters as { USERNAME: string }).USERNAME;
        if (email === "stranger@example.com")
          return reply(400, { __type: "UserNotFoundException", message: "internal pool detail" });
        return reply(200, { ChallengeName: "EMAIL_OTP", Session: SESSION });
      }
      const code = (body.ChallengeResponses as { EMAIL_OTP_CODE: string }).EMAIL_OTP_CODE;
      if (code !== "123456") return reply(400, { __type: "CodeMismatchException", message: "no" });
      return reply(200, {
        AuthenticationResult: { AccessToken: account.access, RefreshToken: REFRESH, ExpiresIn: 3600 },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return {
    account,
    calls,
    refresh,
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
  };
}

async function fixture(options: { idle?: () => boolean; platform?: string; hosted?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mac-account-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const account = await accountService();
  const settings = new SettingsStore(join(dir, "settings.json"));
  const credentials = new FileCredentialStore(join(dir, "credentials.json"));
  const restarts: string[] = [];
  const boundary = new LocalCompanionBoundary();
  const eventLogPath = join(dir, "events.jsonl");
  const app: ClankieApp = await createClankieApp({
    captain: createStubCaptain(),
    eventLogPath,
    deviceSessionKey: randomBytes(32),
    modelDeviceSetup: { platform: options.platform ?? "darwin", hosted: options.hosted ?? false },
    isSameMacRequest: (request) => boundary.isSameMac(request),
    settings,
    macAccount: {
      credentials,
      restartWhenIdle: () => {
        restarts.push("asked");
        return options.idle?.() ?? true;
      },
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  } as Parameters<typeof createClankieApp>[0]);
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: boundary.fetch((request) => app.app.fetch(request)),
  }) as Server;
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        app.close();
        server.close(() => resolve());
      }),
  );
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const owner = { authorization: "Bearer owner" };
  /** A real paired device, through the same offer the phone uses. */
  const pair = async (acceptedGrants: unknown = TAKE_CONTROL_GRANTS) => {
    const offer = (await (await call("/v1/pairing/offer", {}, owner)).json()) as { localCode: string };
    const redeemed = (await (
      await call("/v1/pairing/redeem", {
        code: offer.localCode,
        device: { name: "Mac", platform: "macos" },
      })
    ).json()) as { completionToken: string };
    const completed = await call("/v1/pairing/complete", {
      completionToken: redeemed.completionToken,
      acceptedGrants,
    });
    expect(completed.status).toBe(200);
    const { deviceToken } = (await completed.json()) as { deviceToken: string };
    return { authorization: `Bearer ${deviceToken}` };
  };
  const useFixtureGateway = (installationId: string) =>
    settings.update((current) => ({
      ...current,
      publicGateway: { url: account.url, installationId },
    }));
  return { account, call, credentials, eventLogPath, owner, pair, restarts, settings, useFixtureGateway };
}

const INSTALLATION = "AAAAAAAAAAAAAAAAAAAAAA";

const doorwayOptions = (f: Awaited<ReturnType<typeof fixture>>) => ({
  publicGateway: { url: f.account.url, installationId: INSTALLATION },
  store: f.credentials,
  env: {},
  port: 1,
  relayPort: 2,
  logger: { info: () => undefined, warn: () => undefined },
});

describe("signing this Mac in from the app", () => {
  it("takes a Take Control device from email to stored tokens without a token crossing the route", async () => {
    const f = await fixture();
    const device = await f.pair();
    expect(await (await f.call(MAC_ACCOUNT_PATH, undefined, device)).json()).toEqual({
      state: "never_set_up",
      pending: false,
      doorway: { state: "disabled" },
    });
    await f.useFixtureGateway(INSTALLATION);
    expect(await (await f.call(MAC_ACCOUNT_PATH, undefined, device)).json()).toMatchObject({
      state: "signed_out",
    });

    const started = await f.call(MAC_ACCOUNT_START_PATH, { email: " Owner@Example.com " }, device);
    expect(started.status).toBe(200);
    expect(started.headers.get("cache-control")).toBe("no-store");
    const startText = await started.text();
    expect(JSON.parse(startText)).toMatchObject({ email: "owner@example.com" });
    expect(f.account.calls.at(-1)).toMatchObject({
      target: "InitiateAuth",
      body: { AuthParameters: { USERNAME: "owner@example.com", PREFERRED_CHALLENGE: "EMAIL_OTP" } },
    });
    expect(await (await f.call(MAC_ACCOUNT_PATH, undefined, device)).json()).toMatchObject({ pending: true });

    const wrong = await f.call(MAC_ACCOUNT_COMPLETE_PATH, { code: "000000" }, device);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "code_invalid" });

    const completed = await f.call(MAC_ACCOUNT_COMPLETE_PATH, { code: "123456" }, device);
    expect(completed.status).toBe(200);
    const completeText = await completed.text();
    expect(JSON.parse(completeText)).toEqual({
      state: "signed_in",
      email: "owner@example.com",
      restart: "restarting",
    });
    expect(f.restarts).toEqual(["asked"]);

    const stored = await f.credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID);
    expect(stored).toMatchObject({
      type: "oauth",
      access: ACCESS,
      refresh: REFRESH,
      accountId: "account-sub",
      metadata: { email: "owner@example.com" },
    });
    // A signed-out Mac keeps its installation, so its host id and paired phones survive.
    expect((await f.settings.load()).publicGateway).toEqual({
      url: f.account.url,
      installationId: INSTALLATION,
    });
    const statusText = await (await f.call(MAC_ACCOUNT_PATH, undefined, device)).text();
    expect(JSON.parse(statusText)).toMatchObject({
      state: "signed_in",
      email: "owner@example.com",
      pending: false,
    });

    const events = await readFile(f.eventLogPath, "utf8");
    expect(events).toContain("mac_account.signed_in");
    for (const secret of [ACCESS, REFRESH, SESSION])
      for (const seen of [startText, completeText, statusText, events]) expect(seen).not.toContain(secret);

    // The code is spent.
    expect((await f.call(MAC_ACCOUNT_COMPLETE_PATH, { code: "123456" }, device)).status).toBe(409);
  });

  it("takes no gateway from the caller", async () => {
    const f = await fixture();
    await f.useFixtureGateway(INSTALLATION);
    const started = await f.call(
      MAC_ACCOUNT_START_PATH,
      { email: "owner@example.com", gatewayUrl: "https://evil.example" },
      f.owner,
    );
    expect(started.status).toBe(400);
    expect(f.account.calls).toEqual([]);
  });

  it("admits only this Mac's own loopback, whatever the credential", async () => {
    const f = await fixture();
    await f.useFixtureGateway(INSTALLATION);
    const device = await f.pair();
    const body = { email: "owner@example.com" };
    expect((await f.call(MAC_ACCOUNT_PATH)).status).toBe(401);
    expect((await f.call(MAC_ACCOUNT_START_PATH, body)).status).toBe(401);
    expect((await f.call(MAC_ACCOUNT_PATH, undefined, { authorization: "Bearer nope" })).status).toBe(401);
    for (const credential of [device, f.owner])
      for (const forwarded of [
        { "x-clankie-gateway": "1" },
        { "x-forwarded-for": "203.0.113.9" },
        { forwarded: "for=203.0.113.9" },
        { origin: "https://evil.example" },
        { referer: "https://evil.example/" },
        { "sec-fetch-site": "cross-site" },
      ]) {
        // A browser Origin is refused earlier still, by the service's CORS gate.
        const refused = await f.call(MAC_ACCOUNT_START_PATH, body, { ...credential, ...forwarded });
        expect(refused.status).toBe(403);
      }
    expect(f.account.calls).toEqual([]);
  });

  it("refuses a device without Take Control", async () => {
    const f = await fixture();
    const readOnly = await f.pair({ ...TAKE_CONTROL_GRANTS, terminalControl: false });
    const refused = await f.call(MAC_ACCOUNT_PATH, undefined, readOnly);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "forbidden" });
  });

  it("is on neither the gateway's nor the hosted operator's routes", () => {
    for (const path of [MAC_ACCOUNT_PATH, MAC_ACCOUNT_START_PATH, MAC_ACCOUNT_COMPLETE_PATH])
      for (const method of ["GET", "POST"] as const) {
        expect(publicGatewayTargetFor(method, path)).toBeUndefined();
        expect(hostedOperatorAllows(method, path)).toBe(false);
      }
  });

  it("lets only the identity that asked for the code spend it, five tries at most", async () => {
    const f = await fixture();
    await f.useFixtureGateway(INSTALLATION);
    const device = await f.pair();
    await f.call(MAC_ACCOUNT_START_PATH, { email: "owner@example.com" }, f.owner);
    expect((await f.call(MAC_ACCOUNT_COMPLETE_PATH, { code: "123456" }, device)).status).toBe(409);
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect((await f.call(MAC_ACCOUNT_COMPLETE_PATH, { code: "000000" }, f.owner)).status).toBe(400);
    expect((await f.call(MAC_ACCOUNT_COMPLETE_PATH, { code: "123456" }, f.owner)).status).toBe(409);
    expect(await f.credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID)).toBeUndefined();
  });

  it("names a refusal by code and repeats nothing Cognito said", async () => {
    const f = await fixture();
    await f.useFixtureGateway(INSTALLATION);
    const refused = await f.call(MAC_ACCOUNT_START_PATH, { email: "stranger@example.com" }, f.owner);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "account_not_invited" });
  });

  it("waits for him to be idle before restarting, and keeps asking", async () => {
    let idle = false;
    const f = await fixture({ idle: () => idle });
    await f.useFixtureGateway(INSTALLATION);
    await f.call(MAC_ACCOUNT_START_PATH, { email: "owner@example.com" }, f.owner);
    const completed = await f.call(MAC_ACCOUNT_COMPLETE_PATH, { code: "123456" }, f.owner);
    expect(await completed.json()).toMatchObject({ restart: "waiting" });
    expect(await f.credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID)).toBeDefined();
    idle = true;
    await expect.poll(() => f.restarts.length, { timeout: 7_000 }).toBeGreaterThan(1);
  }, 10_000);

  it.each([
    {
      name: "another account",
      sub: "account-sub",
      bootsAs: "account-sub",
      oldConnection: "account_replaced",
    },
    { name: "the same account", sub: "old-sub", bootsAs: "old-sub", oldConnection: undefined },
  ])("keeps a sign-in to $name over a refresh already in flight, through the restart", async (t) => {
    const f = await fixture();
    await f.useFixtureGateway(INSTALLATION);
    await f.credentials.set(CLANKIE_ACCOUNT_PROVIDER_ID, {
      type: "oauth",
      access: accessFor("old-sub"),
      refresh: "old-refresh",
      expires: Date.now() - 1,
      accountId: "old-sub",
      clientId: CLIENT_ID,
    });
    f.account.account.access = accessFor(t.sub);
    let answerRefresh = () => {};
    f.account.refresh.hold = new Promise((resolve) => (answerRefresh = resolve));
    const reached = new Promise<void>((resolve) => (f.account.refresh.reached = resolve));

    // The live doorway, as boot builds it, mid-refresh when the owner signs in.
    const { connector } = await connectBodyToGateway(doorwayOptions(f));
    expect(connector).toBeDefined();
    const resolveToken = createClankieAccountTokenProvider({
      gatewayUrl: f.account.url,
      store: f.credentials,
      accountId: "old-sub",
    });
    // It finishes wholly before the sign-in lands, so its token is the old account's.
    const inFlight = resolveToken();
    await reached;
    await f.call(MAC_ACCOUNT_START_PATH, { email: "owner@example.com" }, f.owner);
    const completing = f.call(MAC_ACCOUNT_COMPLETE_PATH, { code: "123456" }, f.owner);
    await expect.poll(() => f.account.calls.at(-1)?.target).toBe("RespondToAuthChallenge");
    answerRefresh();
    expect((await completing).status).toBe(200);
    expect((await inFlight).accountId).toBe("old-sub");
    expect(await f.credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID)).toMatchObject({
      access: accessFor(t.sub),
      refresh: REFRESH,
      accountId: t.sub,
    });

    // Whatever that connection does next, it never carries the replaced account again.
    const next = await resolveToken().then(
      (token) => ({ code: undefined, token: token.token }),
      (error: { code?: string }) => ({ code: error.code, token: undefined }),
    );
    expect(next.code).toBe(t.oldConnection);
    if (t.oldConnection === undefined) expect(next.token).toBe(accessFor(t.sub));

    // The restart boots on what the sign-in stored.
    const rebooted = await connectBodyToGateway(doorwayOptions(f));
    expect(rebooted.connector?.hostBaseUrl).toContain(derivePublicGatewayHostId(t.bootsAs, INSTALLATION));
  });

  it("does not exist on a hosted body or off macOS", async () => {
    for (const options of [{ hosted: true }, { platform: "linux" }]) {
      const f = await fixture(options);
      expect((await f.call(MAC_ACCOUNT_PATH, undefined, f.owner)).status).toBe(404);
    }
  });
});
