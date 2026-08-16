import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore, type ProviderCredential } from "@clankie/credential-broker";
import { afterEach, describe, expect, it } from "vitest";
import {
  createXaiFetch,
  refreshXaiToken,
  requestXaiDeviceCode,
  runXaiDeviceLogin,
  XAI_DEVICE_AUTHORIZATION_URL,
  XAI_DEVICE_CODE_GRANT_TYPE,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REFERRER,
  XAI_OAUTH_SCOPES,
  XAI_PROVIDER_ID,
  XAI_TOKEN_URL,
  xaiAccessTokenIsExpiring,
} from "../src/oauth/xai.ts";

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
  it("requests a device code with the public Grok-CLI client", async () => {
    let request: { url: string; headers: Headers; body: URLSearchParams } | undefined;
    const device = await requestXaiDeviceCode({
      fetchImpl: async (input, init) => {
        request = {
          url: String(input),
          headers: new Headers(init?.headers),
          body: new URLSearchParams(String(init?.body)),
        };
        return jsonResponse({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.x.ai/activate",
          verification_uri_complete: "https://auth.x.ai/activate?user_code=ABCD-EFGH",
          expires_in: 300,
          interval: 5,
        });
      },
    });

    expect(request?.url).toBe(XAI_DEVICE_AUTHORIZATION_URL);
    expect(request?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(request?.body.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
    expect(request?.body.get("scope")).toBe(XAI_OAUTH_SCOPES);
    expect(request?.body.get("referrer")).toBe(XAI_OAUTH_REFERRER);
    expect(device).toMatchObject({
      deviceCode: "device-secret",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.x.ai/activate",
      verificationUriComplete: "https://auth.x.ai/activate?user_code=ABCD-EFGH",
      expiresInMs: 300_000,
      intervalMs: 5_000,
    });
  });

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
          if (url === XAI_DEVICE_AUTHORIZATION_URL) {
            return jsonResponse({
              device_code: "device-secret",
              user_code: "WXYZ-1234",
              verification_uri: "https://auth.x.ai/activate",
              expires_in: 120,
              interval: 2,
            });
          }
          if (calls.filter((call) => call.grant === XAI_DEVICE_CODE_GRANT_TYPE).length === 1) {
            return jsonResponse({ error: "authorization_pending" }, 400);
          }
          if (calls.filter((call) => call.grant === XAI_DEVICE_CODE_GRANT_TYPE).length === 2) {
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
      XAI_DEVICE_CODE_GRANT_TYPE,
      XAI_DEVICE_CODE_GRANT_TYPE,
      XAI_DEVICE_CODE_GRANT_TYPE,
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
          if (String(input) === XAI_DEVICE_AUTHORIZATION_URL) {
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
  it("refreshes with the prior refresh token and keeps it when rotation omits one", async () => {
    let body: URLSearchParams | undefined;
    const credential = expectOauth(
      await refreshXaiToken(
        { type: "oauth", access: "expired", refresh: "refresh-old", expires: 1 },
        async (_input, init) => {
          body = new URLSearchParams(String(init?.body));
          return jsonResponse({ access_token: "access-next", expires_in: 120 });
        },
      ),
    );

    expect(body?.get("grant_type")).toBe("refresh_token");
    expect(body?.get("refresh_token")).toBe("refresh-old");
    expect(body?.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
    expect(credential).toMatchObject({ access: "access-next", refresh: "refresh-old" });
  });

  it("rejects refresh for API-key credentials", async () => {
    await expect(refreshXaiToken({ type: "api", key: "xai-secret" })).rejects.toThrow(
      "uses oauth credentials",
    );
  });

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
      access: "expired",
      refresh: "refresh-old",
      expires: 1,
    });
    const refreshStarted = deferred();
    const releaseRefresh = deferred();
    let refreshCalls = 0;
    let modelCalls = 0;
    const adapted = createXaiFetch({
      store,
      fetchImpl: async (input) => {
        if (String(input) === XAI_TOKEN_URL) {
          refreshCalls += 1;
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

  it("treats a JWT inside the skew window as expiring", () => {
    expect(xaiAccessTokenIsExpiring(jwtWithExp(Math.floor(Date.now() / 1000) - 60), 0)).toBe(true);
    expect(xaiAccessTokenIsExpiring(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), 0)).toBe(false);
    expect(xaiAccessTokenIsExpiring("opaque-token", 0)).toBe(false);
  });
});
