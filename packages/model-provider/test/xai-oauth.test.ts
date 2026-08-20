import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore, type ProviderCredential } from "@clankie/credential-broker";
import { afterEach, describe, expect, it } from "vitest";
import { createXaiFetch, runXaiDeviceLogin, XAI_PROVIDER_ID } from "../src/oauth/xai.ts";

const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporaryStore(): Promise<FileCredentialStore> {
  const dir = await mkdtemp(join(tmpdir(), "xai-oauth-"));
  tempDirs.push(dir);
  return new FileCredentialStore(join(dir, "credentials.json"));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function expectOauth(
  credential: ProviderCredential | undefined,
): Extract<ProviderCredential, { type: "oauth" }> {
  if (credential?.type !== "oauth") throw new Error(`Expected oauth, got ${credential?.type}`);
  return credential;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("xAI SuperGrok device authorization", () => {
  it("polls through authorization_pending and slow_down until tokens arrive", async () => {
    const calls: Array<{ url: string; grant?: string }> = [];
    const sleeps: number[] = [];
    const credential = expectOauth(
      await runXaiDeviceLogin({
        onUserCode: (code, url) => {
          expect(code).toBe("WXYZ-1234");
          expect(url).toBe("https://auth.x.ai/activate");
        },
        openUrl: () => {},
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        fetchImpl: async (input, init) => {
          const url = String(input);
          const body = new URLSearchParams(String(init?.body));
          const grant = body.get("grant_type");
          calls.push(grant === null ? { url } : { url, grant });
          if (url === DEVICE_AUTHORIZATION_URL) {
            expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
            expect(body.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
            expect(body.get("scope")).toBe("openid profile email offline_access grok-cli:access api:access");
            expect(body.get("referrer")).toBe("opencode");
            return jsonResponse({
              device_code: "device-secret",
              user_code: "WXYZ-1234",
              verification_uri: "https://auth.x.ai/activate",
              expires_in: 120,
              interval: 2,
            });
          }
          if (calls.filter((call) => call.grant === DEVICE_CODE_GRANT_TYPE).length === 1) {
            return jsonResponse({ error: "authorization_pending" }, 400);
          }
          if (calls.filter((call) => call.grant === DEVICE_CODE_GRANT_TYPE).length === 2) {
            return jsonResponse({ error: "slow_down" }, 400);
          }
          return jsonResponse({
            access_token: "access-live",
            refresh_token: "refresh-live",
            expires_in: 900,
          });
        },
      }),
    );

    expect(calls.map((call) => call.grant)).toEqual([
      undefined,
      DEVICE_CODE_GRANT_TYPE,
      DEVICE_CODE_GRANT_TYPE,
      DEVICE_CODE_GRANT_TYPE,
    ]);
    expect(sleeps[0]).toBe(2_000 + 3_000);
    expect(sleeps[1]).toBe(7_000 + 3_000);
    expect(credential).toMatchObject({ type: "oauth", access: "access-live", refresh: "refresh-live" });
  });

  it("fails a denied device authorization without storing tokens", async () => {
    await expect(
      runXaiDeviceLogin({
        onUserCode: () => {},
        openUrl: () => {},
        fetchImpl: async (input) => {
          if (String(input) === DEVICE_AUTHORIZATION_URL) {
            return jsonResponse({
              device_code: "device-secret",
              user_code: "DENIED",
              verification_uri: "https://auth.x.ai/activate",
              expires_in: 60,
              interval: 1,
            });
          }
          return jsonResponse({ error: "access_denied" }, 400);
        },
      }),
    ).rejects.toThrow("denied");
  });
});

describe("xAI SuperGrok refresh and request adaptation", () => {
  it("replaces the placeholder bearer with the live SuperGrok token", async () => {
    const store = await temporaryStore();
    await store.set(XAI_PROVIDER_ID, {
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: Date.now() + 600_000,
    });
    let headers = new Headers();
    const adapted = createXaiFetch({
      store,
      fetchImpl: async (_input, init) => {
        headers = new Headers(init?.headers);
        return jsonResponse({ ok: true });
      },
    });

    await adapted("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer clankie-oauth" },
    });

    expect(headers.get("authorization")).toBe("Bearer access-secret");
    expect(headers.get("user-agent")).toBe("clankie/1.0.0");
  });

  it("shares one refresh across concurrent requests and persists rotation", async () => {
    const store = await temporaryStore();
    await store.set(XAI_PROVIDER_ID, {
      type: "oauth",
      access: jwtWithExp(Math.floor(Date.now() / 1000) - 60),
      refresh: "refresh-old",
      expires: 0,
    });
    const refreshStarted = deferred();
    const releaseRefresh = deferred();
    let refreshCalls = 0;
    let refreshBody: URLSearchParams | undefined;
    let modelCalls = 0;
    const adapted = createXaiFetch({
      store,
      fetchImpl: async (input, init) => {
        if (String(input) === TOKEN_URL) {
          refreshCalls += 1;
          refreshBody = new URLSearchParams(String(init?.body));
          refreshStarted.resolve();
          await releaseRefresh.promise;
          return jsonResponse({
            access_token: "access-rotated",
            refresh_token: "refresh-rotated",
            expires_in: 3600,
          });
        }
        modelCalls += 1;
        return jsonResponse({ ok: true });
      },
    });

    const first = adapted("https://api.x.ai/v1/responses");
    await refreshStarted.promise;
    const second = adapted("https://api.x.ai/v1/images/generations");
    releaseRefresh.resolve();
    await Promise.all([first, second]);

    expect(refreshCalls).toBe(1);
    expect(refreshBody?.get("grant_type")).toBe("refresh_token");
    expect(refreshBody?.get("refresh_token")).toBe("refresh-old");
    expect(modelCalls).toBe(2);
    expect(expectOauth(await store.get(XAI_PROVIDER_ID))).toMatchObject({
      access: "access-rotated",
      refresh: "refresh-rotated",
    });
  });

  it("honors broker revocation before the next request", async () => {
    const store = await temporaryStore();
    await store.set(XAI_PROVIDER_ID, {
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: Date.now() + 60_000,
    });
    let networkCalls = 0;
    const adapted = createXaiFetch({
      store,
      fetchImpl: async () => {
        networkCalls += 1;
        return jsonResponse({ ok: true });
      },
    });

    expect(await store.delete(XAI_PROVIDER_ID)).toBe(true);
    await expect(adapted("https://api.x.ai/v1/responses")).rejects.toThrow(
      `No oauth credential stored for "${XAI_PROVIDER_ID}"`,
    );
    expect(networkCalls).toBe(0);
  });
});
