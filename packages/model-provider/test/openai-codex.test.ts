import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore, type ProviderCredential } from "@clankie/credential-broker";
import { describe, expect, it } from "vitest";
import {
  buildCodexAuthorizeUrl,
  CODEX_API_ENDPOINT,
  CODEX_CLIENT_ID,
  CODEX_ISSUER,
  CODEX_PROVIDER_ID,
  createCodexFetch,
  extractCodexAccountId,
  generateCodexPkce,
  refreshCodexToken,
  runCodexBrowserLogin,
  runCodexDeviceLogin,
} from "../src/oauth/openai-codex.ts";

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeJwt(payload: unknown): string {
  return `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson(payload)}.fake-signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function tokenResponseBody(input: {
  access: string;
  refresh: string;
  accountId?: string;
  expiresIn?: number;
}) {
  return {
    id_token:
      input.accountId === undefined
        ? fakeJwt({})
        : fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: input.accountId } }),
    access_token: input.access,
    refresh_token: input.refresh,
    expires_in: input.expiresIn ?? 3600,
  };
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  at: number;
}

/** Scripted fetch stub: records every call and delegates to the handler. No network. */
function recordingFetch(
  handler: (request: RecordedRequest, callIndex: number) => Response | Promise<Response>,
): {
  fetchImpl: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const recorded: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
      at: Date.now(),
    };
    calls.push(recorded);
    return handler(recorded, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function temporaryStore(): Promise<FileCredentialStore> {
  const dir = await mkdtemp(join(tmpdir(), "codex-oauth-"));
  return new FileCredentialStore(join(dir, "credentials.json"));
}

function expectOauth(
  credential: ProviderCredential | undefined,
): Extract<ProviderCredential, { type: "oauth" }> {
  if (credential?.type !== "oauth") throw new Error(`Expected an oauth credential, got ${credential?.type}`);
  return credential;
}

describe("generateCodexPkce", () => {
  it("derives the challenge as BASE64URL(SHA256(verifier)) over a sane verifier", () => {
    const { verifier, challenge } = generateCodexPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challenge).not.toMatch(/[+/=]/);
    expect(generateCodexPkce().verifier).not.toBe(verifier);
  });
});

describe("buildCodexAuthorizeUrl", () => {
  it("includes every parameter opencode sends", () => {
    const raw = buildCodexAuthorizeUrl({
      challenge: "test-challenge",
      state: "test-state",
      redirectUri: "http://localhost:1455/auth/callback",
    });
    const url = new URL(raw);
    expect(`${url.origin}${url.pathname}`).toBe(`${CODEX_ISSUER}/oauth/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CODEX_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(url.searchParams.get("code_challenge")).toBe("test-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("state")).toBe("test-state");
    expect(url.searchParams.get("originator")).toBe("opencode");
  });
});

describe("extractCodexAccountId", () => {
  it("reads the chatgpt account id claim path with opencode's precedence", () => {
    expect(
      extractCodexAccountId(
        fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_nested" } }),
      ),
    ).toBe("acct_nested");
    expect(extractCodexAccountId(fakeJwt({ chatgpt_account_id: "acct_direct" }))).toBe("acct_direct");
    expect(extractCodexAccountId(fakeJwt({ organizations: [{ id: "org_fallback" }] }))).toBe("org_fallback");
    expect(
      extractCodexAccountId(
        fakeJwt({
          chatgpt_account_id: "acct_direct",
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_nested" },
          organizations: [{ id: "org_fallback" }],
        }),
      ),
    ).toBe("acct_direct");
  });

  it("returns undefined for garbage or claimless tokens", () => {
    expect(extractCodexAccountId("garbage")).toBeUndefined();
    expect(extractCodexAccountId("")).toBeUndefined();
    expect(extractCodexAccountId("a.b.c")).toBeUndefined();
    expect(
      extractCodexAccountId(`${base64UrlJson({})}.${Buffer.from("not json").toString("base64url")}.sig`),
    ).toBeUndefined();
    expect(extractCodexAccountId(fakeJwt({}))).toBeUndefined();
    expect(extractCodexAccountId(fakeJwt({ organizations: [] }))).toBeUndefined();
  });
});

describe("runCodexDeviceLogin", () => {
  it("polls through pending and slow_down (growing the interval) to a credential", async () => {
    const pollIntervalMs = 40;
    const codes: Array<{ code: string; url: string }> = [];
    const { fetchImpl, calls } = recordingFetch((request, index) => {
      if (index === 0) {
        expect(request.url).toBe(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`);
        expect(JSON.parse(request.body)).toEqual({ client_id: CODEX_CLIENT_ID });
        return jsonResponse({ device_auth_id: "device-1", user_code: "ABCD-1234", interval: "1" });
      }
      if (index === 1) {
        expect(request.url).toBe(`${CODEX_ISSUER}/api/accounts/deviceauth/token`);
        expect(JSON.parse(request.body)).toEqual({ device_auth_id: "device-1", user_code: "ABCD-1234" });
        return jsonResponse({ error: "authorization_pending" }, 403);
      }
      if (index === 2) return jsonResponse({ error: "slow_down" }, 400);
      if (index === 3)
        return jsonResponse({ authorization_code: "device-auth-code", code_verifier: "device-verifier" });
      if (index === 4) {
        expect(request.url).toBe(`${CODEX_ISSUER}/oauth/token`);
        const body = new URLSearchParams(request.body);
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("device-auth-code");
        expect(body.get("code_verifier")).toBe("device-verifier");
        expect(body.get("redirect_uri")).toBe(`${CODEX_ISSUER}/deviceauth/callback`);
        expect(body.get("client_id")).toBe(CODEX_CLIENT_ID);
        return jsonResponse(
          tokenResponseBody({ access: "device-access", refresh: "device-refresh", accountId: "acct_device" }),
        );
      }
      throw new Error(`Unexpected request #${index}: ${request.url}`);
    });

    const credential = expectOauth(
      await runCodexDeviceLogin({
        onUserCode: (code, url) => codes.push({ code, url }),
        fetchImpl,
        pollIntervalMs,
        timeoutMs: 10_000,
      }),
    );

    expect(codes).toEqual([{ code: "ABCD-1234", url: `${CODEX_ISSUER}/codex/device` }]);
    expect(credential.access).toBe("device-access");
    expect(credential.refresh).toBe("device-refresh");
    expect(credential.accountId).toBe("acct_device");
    expect(credential.expires).toBeGreaterThan(Date.now());
    expect(calls).toHaveLength(5);

    // Pending waits one base interval; slow_down grows the next wait by another interval.
    const pendingGap = calls[2]!.at - calls[1]!.at;
    const slowedGap = calls[3]!.at - calls[2]!.at;
    expect(pendingGap).toBeGreaterThanOrEqual(pollIntervalMs - 5);
    expect(slowedGap).toBeGreaterThanOrEqual(2 * pollIntervalMs - 5);
    expect(slowedGap).toBeGreaterThan(pendingGap);
  });

  it("aborts on a non-pending device failure", async () => {
    const { fetchImpl } = recordingFetch((_request, index) => {
      if (index === 0)
        return jsonResponse({ device_auth_id: "device-1", user_code: "ABCD-1234", interval: "1" });
      return jsonResponse({ error: "access_denied" }, 400);
    });
    await expect(
      runCodexDeviceLogin({ onUserCode: () => {}, fetchImpl, pollIntervalMs: 5, timeoutMs: 1000 }),
    ).rejects.toThrow(/Device authorization failed: 400/);
  });
});

describe("refreshCodexToken", () => {
  it("re-extracts accountId from refreshed tokens and rotates the refresh token", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(
        tokenResponseBody({ access: "next-access", refresh: "next-refresh", accountId: "acct_new" }),
      ),
    );
    const refreshed = expectOauth(
      await refreshCodexToken(
        { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1, accountId: "acct_old" },
        fetchImpl,
      ),
    );
    expect(refreshed.access).toBe("next-access");
    expect(refreshed.refresh).toBe("next-refresh");
    expect(refreshed.accountId).toBe("acct_new");
    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
    expect(body.get("client_id")).toBe(CODEX_CLIENT_ID);
  });
});

describe("createCodexFetch", () => {
  it("refreshes an expired credential exactly once across concurrent requests and persists it", async () => {
    const store = await temporaryStore();
    await store.set(CODEX_PROVIDER_ID, {
      type: "oauth",
      access: "stale-access",
      refresh: "stale-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct_old",
    });

    let refreshCount = 0;
    const { fetchImpl, calls } = recordingFetch((request) => {
      if (request.url === `${CODEX_ISSUER}/oauth/token`) {
        refreshCount += 1;
        const body = new URLSearchParams(request.body);
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("stale-refresh");
        return jsonResponse(tokenResponseBody({ access: "fresh-access", refresh: "fresh-refresh" }));
      }
      expect(request.url).toBe(CODEX_API_ENDPOINT);
      return jsonResponse({ ok: true });
    });

    const codexFetch = createCodexFetch({ store, fetchImpl });
    const [first, second] = await Promise.all([
      codexFetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }),
      codexFetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(refreshCount).toBe(1);

    const persisted = expectOauth(await store.get(CODEX_PROVIDER_ID));
    expect(persisted.access).toBe("fresh-access");
    expect(persisted.refresh).toBe("fresh-refresh");
    expect(persisted.expires).toBeGreaterThan(Date.now());
    // The refreshed tokens carried no account claim, so the stored accountId is preserved.
    expect(persisted.accountId).toBe("acct_old");

    const apiCalls = calls.filter((call) => call.url === CODEX_API_ENDPOINT);
    expect(apiCalls).toHaveLength(2);
    for (const call of apiCalls) {
      expect(call.headers.get("authorization")).toBe("Bearer fresh-access");
    }
  });

  it("reroutes /responses to the codex endpoint with subscription headers", async () => {
    const store = await temporaryStore();
    await store.set(CODEX_PROVIDER_ID, {
      type: "oauth",
      access: "valid-access",
      refresh: "valid-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "acct_42",
    });
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ ok: true }));
    const codexFetch = createCodexFetch({ store, fetchImpl, sessionId: "session-123" });

    await codexFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-inbound-api-key", "content-type": "application/json" },
      body: "{}",
    });
    const rerouted = calls[0]!;
    expect(rerouted.url).toBe(CODEX_API_ENDPOINT);
    expect(rerouted.method).toBe("POST");
    expect(rerouted.headers.get("authorization")).toBe("Bearer valid-access");
    expect(rerouted.headers.get("ChatGPT-Account-Id")).toBe("acct_42");
    expect(rerouted.headers.get("originator")).toBe("opencode");
    expect(rerouted.headers.get("User-Agent")).toMatch(/^opencode\//);
    expect(rerouted.headers.get("session-id")).toBe("session-123");
    expect(rerouted.headers.get("content-type")).toBe("application/json");

    await codexFetch("https://api.openai.com/v1/models");
    expect(calls[1]!.url).toBe("https://api.openai.com/v1/models");
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer valid-access");

    // A valid credential never touches the token endpoint.
    expect(calls.some((call) => call.url === `${CODEX_ISSUER}/oauth/token`)).toBe(false);
  });

  it("treats expires === 0 as non-expiring and throws when no credential is stored", async () => {
    const store = await temporaryStore();
    await store.set(CODEX_PROVIDER_ID, { type: "oauth", access: "eternal", refresh: "r", expires: 0 });
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ ok: true }));
    const codexFetch = createCodexFetch({ store, fetchImpl });
    await codexFetch("https://api.openai.com/v1/responses");
    expect(calls.some((call) => call.url === `${CODEX_ISSUER}/oauth/token`)).toBe(false);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer eternal");

    const emptyStore = await temporaryStore();
    const missing = createCodexFetch({ store: emptyStore, fetchImpl });
    await expect(missing("https://api.openai.com/v1/responses")).rejects.toThrow(CODEX_PROVIDER_ID);
  });
});

describe("runCodexBrowserLogin", () => {
  it("serves the callback, verifies state, exchanges the code, and resolves a credential", async () => {
    const opened = deferred<string>();
    const { fetchImpl, calls } = recordingFetch((request) => {
      expect(request.url).toBe(`${CODEX_ISSUER}/oauth/token`);
      return jsonResponse(
        tokenResponseBody({
          access: "browser-access",
          refresh: "browser-refresh",
          accountId: "acct_browser",
        }),
      );
    });

    const login = runCodexBrowserLogin({
      port: 0,
      openUrl: (url) => opened.resolve(url),
      fetchImpl,
      timeoutMs: 10_000,
    });

    const authorizeUrl = new URL(await opened.promise);
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${CODEX_ISSUER}/oauth/authorize`);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri")!;
    const state = authorizeUrl.searchParams.get("state")!;
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/);
    expect(redirectUri).not.toContain(":1455/");

    const callbackUrl = new URL(redirectUri.replace("localhost", "127.0.0.1"));
    callbackUrl.searchParams.set("code", "browser-code");
    callbackUrl.searchParams.set("state", state);
    const callback = await fetch(callbackUrl);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Login successful");

    const credential = expectOauth(await login);
    expect(credential.access).toBe("browser-access");
    expect(credential.refresh).toBe("browser-refresh");
    expect(credential.accountId).toBe("acct_browser");
    expect(credential.expires).toBeGreaterThan(Date.now());

    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("browser-code");
    expect(body.get("redirect_uri")).toBe(redirectUri);
    expect(body.get("client_id")).toBe(CODEX_CLIENT_ID);
    // PKCE round trip: the verifier sent to the token endpoint hashes to the advertised challenge.
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
      authorizeUrl.searchParams.get("code_challenge"),
    );
  });

  it("rejects the login and returns 400 when the callback state does not match", async () => {
    const opened = deferred<string>();
    const { fetchImpl, calls } = recordingFetch(() => {
      throw new Error("the token endpoint must not be called");
    });

    const login = runCodexBrowserLogin({
      port: 0,
      openUrl: (url) => opened.resolve(url),
      fetchImpl,
      timeoutMs: 10_000,
    });

    // Attach the rejection handler before the callback fires so the rejection is never unhandled.
    const rejection = expect(login).rejects.toThrow(/Invalid state/);

    const authorizeUrl = new URL(await opened.promise);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri")!;
    const callbackUrl = new URL(redirectUri.replace("localhost", "127.0.0.1"));
    callbackUrl.searchParams.set("code", "browser-code");
    callbackUrl.searchParams.set("state", "wrong-state");
    const callback = await fetch(callbackUrl);
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("Login failed");

    await rejection;
    expect(calls).toHaveLength(0);
  });
});
