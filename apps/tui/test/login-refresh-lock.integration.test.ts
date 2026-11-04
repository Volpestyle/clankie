import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLANKIE_ACCOUNT_PROVIDER_ID, FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";

const CLIENT_ID = "fixtureclient";
const accessFor = (sub: string) =>
  `h.${Buffer.from(JSON.stringify({ sub, client_id: CLIENT_ID, token_use: "access" })).toString("base64url")}.s`;
/** Each refresh attempt answers just inside the 10-second request timeout. */
const SLOW_REPLY_MS = 9_000;
/** Attempts that fail before the refresh succeeds, all inside its recovery window. */
const FAILED_REFRESHES = 3;

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const bodyOf = async (request: IncomingMessage) => {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
};

/**
 * The gateway's discovery and Cognito over real HTTP. A refresh is slow and
 * fails a few times before it succeeds, so it holds the credential lock for
 * about 38 seconds: longer than one lock attempt waits.
 */
async function accountService() {
  const events: { readonly at: number; readonly what: string }[] = [];
  let refreshes = 0;
  let reachedRefresh: () => void = () => undefined;
  const refreshing = new Promise<void>((resolve) => (reachedRefresh = resolve));
  const server: Server = createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/x-amz-json-1.1");
      response.end(JSON.stringify(value));
    };
    if (request.method === "HEAD") return reply(405, {});
    if (request.url === "/gateway/v1/config") {
      const { port } = server.address() as AddressInfo;
      return reply(200, {
        schemaVersion: 1,
        account: {
          provider: "cognito_email_otp",
          endpoint: `http://127.0.0.1:${String(port)}`,
          issuer: "https://cognito-idp.us-east-1.amazonaws.com/fixture",
          clientId: CLIENT_ID,
          selfSignUpEnabled: false,
        },
      });
    }
    const target = String(request.headers["x-amz-target"]).split(".").at(-1)!;
    const body = JSON.parse(await bodyOf(request)) as Record<string, any>;
    if (target === "GetTokensFromRefreshToken") {
      reachedRefresh();
      const attempt = (refreshes += 1);
      await new Promise((wait) => setTimeout(wait, SLOW_REPLY_MS));
      if (attempt <= FAILED_REFRESHES) return reply(500, { __type: "InternalErrorException" });
      events.push({ at: Date.now(), what: "refreshed" });
      return reply(200, {
        AuthenticationResult: { AccessToken: accessFor("old-account"), ExpiresIn: 3600 },
      });
    }
    if (target === "InitiateAuth") return reply(200, { ChallengeName: "EMAIL_OTP", Session: "session" });
    if (target === "RespondToAuthChallenge") {
      if (body.ChallengeResponses?.EMAIL_OTP_CODE !== "123456")
        return reply(400, { __type: "CodeMismatchException" });
      events.push({ at: Date.now(), what: "signed in" });
      return reply(200, {
        AuthenticationResult: {
          AccessToken: accessFor("new-account"),
          RefreshToken: "new-refresh",
          ExpiresIn: 3600,
        },
      });
    }
    return reply(400, { __type: "UnknownOperationException" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    events,
    refreshing,
  };
}

function run(args: readonly string[], env: NodeJS.ProcessEnv, stdin = "") {
  const child = spawn(process.execPath, args, {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanups.push(() => void child.kill());
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  child.stdin.end(stdin);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
    child.once("exit", (code) => done({ code, stdout, stderr })),
  );
}

describe("clankie login while the service refreshes the account token (#791)", () => {
  it(
    "waits out a refresh in another process, then stores the sign-in over it",
    { timeout: 120_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "login-refresh-lock-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const account = await accountService();
      const credentialsPath = join(dir, "credentials.json");
      const settingsPath = join(dir, "settings.json");
      const credentials = new FileCredentialStore(credentialsPath);
      // The Mac's earlier sign-in, due for refresh.
      await credentials.set(CLANKIE_ACCOUNT_PROVIDER_ID, {
        type: "oauth",
        access: accessFor("old-account"),
        refresh: "old-refresh",
        expires: 1,
        accountId: "old-account",
        clientId: CLIENT_ID,
      });

      const refresh = run(
        [resolve(import.meta.dirname, "fixtures/account-refresh.ts"), account.url, credentialsPath],
        {},
      );
      // Discovery is outside the lock; once Cognito hears the refresh, the lock is held.
      await account.refreshing;
      const login = run(
        [
          resolve(import.meta.dirname, "../bin/clankie.ts"),
          "login",
          "--url",
          account.url,
          "--email",
          "owner@example.com",
          "--code-stdin",
        ],
        {
          XDG_CONFIG_HOME: join(dir, "config"),
          CLANKIE_SETTINGS_FILE: settingsPath,
          CLANKIE_CREDENTIALS_FILE: credentialsPath,
          // No service is reached; the CLI only stores the sign-in.
          CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:9",
        },
        "123456\n",
      );
      const [refreshed, loggedIn] = await Promise.all([refresh, login]);

      // The refresh ends as a refresh, and the sign-in ends signed in.
      expect(refreshed).toMatchObject({ code: 0 });
      expect(JSON.parse(refreshed.stdout)).toEqual({ accountId: "old-account" });
      expect(loggedIn).toMatchObject({ code: 0 });
      expect(JSON.parse(loggedIn.stdout)).toMatchObject({ ok: true, mode: "remote-access" });
      // The code was spent while the refresh still held the lock, longer than one lock attempt waits.
      const at = (what: string) => account.events.find((event) => event.what === what)!.at;
      expect(at("refreshed") - at("signed in")).toBeGreaterThan(27_000);
      // The sign-in landed after the refresh, so it is what this Mac holds.
      expect(await credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID)).toMatchObject({
        accountId: "new-account",
        refresh: "new-refresh",
        metadata: { email: "owner@example.com" },
      });
      expect((await new SettingsStore(settingsPath).load()).publicGateway.url).toBe(account.url);
    },
  );
});
