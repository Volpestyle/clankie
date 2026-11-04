import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { CLANKIE_ACCOUNT_PROVIDER_ID, FileCredentialStore } from "@clankie/credential-broker";
import { LocalCompanionHandoffSchema, LocalCompanionSessionSchema } from "@clankie/protocol/local-companion";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createClankieAccountSignIn } from "../src/clankie-account-signin.ts";
import { LocalCompanionBoundary } from "../src/local-companion-boundary.ts";
import { startLocalCompanionIssuer } from "../src/local-companion-issuer.ts";
import { writeLocalCompanionHandoff } from "../../tui/bin/local-companion.ts";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

const jwt = (claims: Record<string, unknown>) =>
  [{ alg: "none" }, claims, "sig"]
    .map((part) => Buffer.from(typeof part === "string" ? part : JSON.stringify(part)).toString("base64url"))
    .join(".");

const bodyOf = async (request: IncomingMessage) => {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
};

/**
 * A loopback stand-in for the gateway's config and Cognito's EMAIL_OTP
 * exchange: the only code that works is 24680, and every secret it issues is
 * recorded so the test can prove none reaches the app.
 */
async function fakeAccountService() {
  const access = jwt({ sub: "account-1", client_id: "client123", token_use: "access" });
  const secrets = { access, refresh: "refresh-secret-1", session: "cognito-session-secret-1" };
  const targets: string[] = [];
  let origin = "";
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/x-amz-json-1.1" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/gateway/v1/config") {
      return send(200, {
        schemaVersion: 1,
        account: {
          provider: "cognito_email_otp",
          endpoint: origin,
          issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool",
          clientId: "client123",
          selfSignUpEnabled: false,
        },
      });
    }
    const target = String(request.headers["x-amz-target"] ?? "");
    targets.push(target);
    const body = JSON.parse(await bodyOf(request)) as Record<string, any>;
    if (target === "AWSCognitoIdentityProviderService.InitiateAuth")
      return send(200, { ChallengeName: "EMAIL_OTP", Session: secrets.session });
    if (target === "AWSCognitoIdentityProviderService.RespondToAuthChallenge") {
      if (body.Session !== secrets.session) return send(400, { __type: "NotAuthorizedException" });
      if (body.ChallengeResponses?.EMAIL_OTP_CODE !== "24680")
        return send(400, { __type: "CodeMismatchException", message: "Invalid code" });
      return send(200, {
        AuthenticationResult: { AccessToken: access, RefreshToken: secrets.refresh, ExpiresIn: 3600 },
      });
    }
    return send(400, { __type: "UnknownOperationException" });
  });
  origin = await listen(server);
  return { origin, secrets, targets };
}

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "account-signin-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o755);
  const account = await fakeAccountService();
  const credentials = new FileCredentialStore(join(dir, "credentials.json"));
  const settings = new SettingsStore(join(dir, "settings.json"));
  const boundary = new LocalCompanionBoundary();
  const app: ClankieApp = await createClankieApp({
    captain: createStubCaptain(),
    eventLogPath: join(dir, "events.jsonl"),
    deviceSessionKey: randomBytes(32),
    modelDeviceSetup: { platform: "darwin", hosted: false },
    isLocalCompanionRequest: (request) => boundary.has(request),
    localCompanionOwner: (request) => boundary.privateOwner(request),
    isSameMacRequest: (request) => boundary.isSameMac(request),
    // The signed-app check has its own codesign proof; here the same-Mac socket is the app.
    verifyLocalCompanionApp: async (request) =>
      boundary.loopbackPorts(request) === undefined
        ? { ok: false, reason: "peer_unknown" }
        : {
            ok: true,
            app: { pid: process.pid, identifier: "fixture.companion" },
            trusted: {
              id: "00000000-0000-4000-8000-000000000001",
              label: "fixture",
              requirement: 'identifier "fixture.companion"',
              identifier: "fixture.companion",
              addedAt: new Date(0).toISOString(),
            },
          },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    clankieAccountSignIn: createClankieAccountSignIn({ credentials, settings, gatewayUrl: account.origin }),
  });
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
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bodies: string[] = [];
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
  };
  const issuer = await startLocalCompanionIssuer({
    stateRoot: dir,
    controlPlaneUrl: origin,
    boundary,
    owner: { operatorId: "owner" },
    fetch: (request) => app.app.fetch(request),
  });
  cleanups.push(() => issuer.close());
  // The Mac app's own device session, through the real local companion pairing.
  const handoffPath = await writeLocalCompanionHandoff({
    env: { CLANKIE_STATE: dir },
    controlPlaneUrl: origin,
    operatorToken: "owner",
  });
  const handoff = LocalCompanionHandoffSchema.parse(JSON.parse(await readFile(handoffPath, "utf8")));
  const redeemed = await call("/v1/pairing/local/redeem", { offerSecret: handoff.offerSecret });
  expect(redeemed.status).toBe(200);
  const session = LocalCompanionSessionSchema.parse(redeemed.body);
  return {
    dir,
    account,
    credentials,
    settings,
    call,
    bodies,
    macApp: { authorization: `Bearer ${session.deviceToken}` },
  };
}

describe("this Mac's clankie.bot sign-in from the owner's app (#722)", () => {
  it("admits only the owner on this Mac, signs in with an emailed code, and never returns a token", async () => {
    const f = await fixture();

    // Admission is the pairing offer's: no caller, a forwarded caller, or a browser origin is refused.
    expect((await f.call("/v1/clankie-account")).status).toBe(401);
    expect(
      (await f.call("/v1/clankie-account", undefined, { ...f.macApp, "x-clankie-gateway": "1" })).status,
    ).toBe(401);
    expect(
      (await f.call("/v1/clankie-account", undefined, { ...f.macApp, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect(
      (
        await f.call(
          "/v1/clankie-account/start",
          { email: "owner@example.com" },
          { "x-forwarded-for": "10.0.0.2" },
        )
      ).status,
    ).toBe(401);
    expect(f.account.targets).toEqual([]);

    expect(await f.call("/v1/clankie-account", undefined, f.macApp)).toEqual({
      status: 200,
      body: { state: "never_set_up" },
    });
    expect(await f.call("/v1/clankie-account", undefined, { authorization: "Bearer owner" })).toEqual({
      status: 200,
      body: { state: "never_set_up" },
    });

    expect((await f.call("/v1/clankie-account/start", { email: "x" }, f.macApp)).status).toBe(400);
    const started = await f.call("/v1/clankie-account/start", { email: " Owner@Example.com " }, f.macApp);
    expect(started.status).toBe(200);
    expect(Object.keys(started.body).sort()).toEqual(["challengeId", "expiresAt"]);
    const { challengeId } = started.body as { challengeId: string };

    expect(await f.call("/v1/clankie-account/complete", { challengeId, code: "11111" }, f.macApp)).toEqual({
      status: 400,
      body: { error: "code_invalid" },
    });
    expect(await f.credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID)).toBeUndefined();

    const done = await f.call("/v1/clankie-account/complete", { challengeId, code: "24680" }, f.macApp);
    expect(done).toEqual({
      status: 200,
      body: {
        state: "signed_in",
        email: "owner@example.com",
        doorway: { state: "disabled" },
        restartRequired: true,
      },
    });
    expect(await f.credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID)).toMatchObject({
      type: "oauth",
      access: f.account.secrets.access,
      refresh: f.account.secrets.refresh,
      accountId: "account-1",
      metadata: { email: "owner@example.com" },
    });
    const publicGateway = (await f.settings.load()).publicGateway;
    expect(publicGateway.url).toBe(f.account.origin);
    expect(publicGateway.installationId).toHaveLength(22);

    // The challenge is single-use, and status keeps naming the account.
    expect(await f.call("/v1/clankie-account/complete", { challengeId, code: "24680" }, f.macApp)).toEqual({
      status: 404,
      body: { error: "challenge_unknown" },
    });
    expect((await f.call("/v1/clankie-account", undefined, f.macApp)).body).toMatchObject({
      state: "signed_in",
      email: "owner@example.com",
    });

    // A second sign-in keeps this Mac's installation id, so its host id survives.
    const again = await f.call("/v1/clankie-account/start", { email: "owner@example.com" }, f.macApp);
    await f.call(
      "/v1/clankie-account/complete",
      { challengeId: again.body.challengeId, code: "24680" },
      f.macApp,
    );
    expect((await f.settings.load()).publicGateway.installationId).toBe(publicGateway.installationId);

    for (const secret of Object.values(f.account.secrets))
      for (const body of f.bodies) expect(body).not.toContain(secret);
  });

  it("drops a pending code after five wrong tries", async () => {
    const f = await fixture();
    const { challengeId } = (
      await f.call("/v1/clankie-account/start", { email: "owner@example.com" }, f.macApp)
    ).body as { challengeId: string };
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(
        (await f.call("/v1/clankie-account/complete", { challengeId, code: "00000" }, f.macApp)).status,
      ).toBe(400);
    expect(
      (await f.call("/v1/clankie-account/complete", { challengeId, code: "24680" }, f.macApp)).status,
    ).toBe(404);
    expect(await f.credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID)).toBeUndefined();
  });
});
