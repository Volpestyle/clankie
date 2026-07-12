import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore, type ProviderCredential } from "@clankie/credential-broker";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTHROPIC_AUTHORIZE_ENDPOINT,
  ANTHROPIC_OAUTH_BETA_FEATURES,
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_SCOPES,
  ANTHROPIC_PROVIDER_ID,
  ANTHROPIC_REDIRECT_URI,
  ANTHROPIC_TOKEN_ENDPOINT,
  buildAnthropicAuthorizeUrl,
  createAnthropicAuthorization,
  createAnthropicFetch,
  exchangeAnthropicCode,
  generateAnthropicPkce,
  refreshAnthropicToken,
  runAnthropicBrowserLogin,
} from "../src/oauth/anthropic.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporaryStore(): Promise<FileCredentialStore> {
  const dir = await mkdtemp(join(tmpdir(), "anthropic-oauth-"));
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

describe("Anthropic OAuth authorization", () => {
  it("generates an RFC 7636 S256 challenge", () => {
    const { verifier, challenge } = generateAnthropicPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("builds the recovered Claude Pro/Max manual-code URL", () => {
    const raw = buildAnthropicAuthorizeUrl({ challenge: "pkce-challenge", state: "oauth-state" });
    const url = new URL(raw);

    expect(`${url.origin}${url.pathname}`).toBe(ANTHROPIC_AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("client_id")).toBe(ANTHROPIC_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(ANTHROPIC_REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(ANTHROPIC_OAUTH_SCOPES);
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("oauth-state");
  });

  it("keeps PKCE verifier and OAuth state separate in memory", () => {
    const authorization = createAnthropicAuthorization();
    const url = new URL(authorization.url);

    expect(authorization.verifier).not.toBe(authorization.state);
    expect(url.searchParams.get("state")).toBe(authorization.state);
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(authorization.verifier).digest("base64url"),
    );
  });

  it("validates returned state before exchanging the pasted code", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({});
    };

    await expect(
      exchangeAnthropicCode({
        code: "authorization-code#wrong-state",
        verifier: "pkce-verifier",
        state: "expected-state",
        fetchImpl,
      }),
    ).rejects.toThrow("Invalid state");
    expect(calls).toBe(0);
  });

  it("exchanges the pasted code with Anthropic's JSON token contract", async () => {
    let request: { url: string; headers: Headers; body: Record<string, string> } | undefined;
    const before = Date.now();
    const fetchImpl: typeof fetch = async (input, init) => {
      request = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, string>,
      };
      return jsonResponse({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 900 });
    };

    const credential = expectOauth(
      await exchangeAnthropicCode({
        code: " authorization-code#returned-state ",
        verifier: "pkce-verifier",
        state: "returned-state",
        fetchImpl,
      }),
    );

    expect(request?.url).toBe(ANTHROPIC_TOKEN_ENDPOINT);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.body).toEqual({
      code: "authorization-code",
      state: "returned-state",
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      code_verifier: "pkce-verifier",
    });
    expect(credential).toMatchObject({
      type: "oauth",
      access: "access-new",
      refresh: "refresh-new",
    });
    expect(credential.expires).toBeGreaterThanOrEqual(before + 900_000);
  });

  it("opens the browser flow and persists tokens only through the broker", async () => {
    const store = await temporaryStore();
    let openedUrl = "";
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ access_token: "stored-access", refresh_token: "stored-refresh", expires_in: 60 });

    await runAnthropicBrowserLogin({
      store,
      openUrl(url) {
        openedUrl = url;
      },
      async readCode(authorization) {
        expect(authorization.url).toBe(openedUrl);
        return `stored-code#${authorization.state}`;
      },
      fetchImpl,
    });

    expect(new URL(openedUrl).origin).toBe("https://claude.ai");
    expect(await store.list()).toEqual({
      anthropic: expect.objectContaining({ type: "oauth" }),
    });
    expect(expectOauth(await store.get(ANTHROPIC_PROVIDER_ID))).toMatchObject({
      access: "stored-access",
      refresh: "stored-refresh",
    });
  });
});

describe("Anthropic OAuth refresh and request adaptation", () => {
  it("refreshes with the prior refresh token and preserves it when rotation omits one", async () => {
    let body: Record<string, string> | undefined;
    const credential = expectOauth(
      await refreshAnthropicToken(
        { type: "oauth", access: "expired", refresh: "refresh-old", expires: 1 },
        async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, string>;
          return jsonResponse({ access_token: "access-next", expires_in: 120 });
        },
      ),
    );

    expect(body).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-old",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    });
    expect(credential).toMatchObject({ access: "access-next", refresh: "refresh-old" });
  });

  it("rejects refresh for API-key credentials", async () => {
    await expect(refreshAnthropicToken({ type: "api", key: "api-secret" })).rejects.toThrow(
      "uses oauth credentials",
    );
  });

  it("strips the API key and attaches bearer plus required beta features", async () => {
    const store = await temporaryStore();
    await store.set(ANTHROPIC_PROVIDER_ID, {
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: Date.now() + 60_000,
    });
    let headers = new Headers();
    const adapted = createAnthropicFetch({
      store,
      fetchImpl: async (_input, init) => {
        headers = new Headers(init?.headers);
        return jsonResponse({ ok: true });
      },
    });

    await adapted("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "placeholder-must-not-leak",
        authorization: "Bearer stale",
        "anthropic-beta": "context-1m-2025-08-07,oauth-2025-04-20",
      },
    });

    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer access-secret");
    const features = headers.get("anthropic-beta")?.split(",") ?? [];
    expect(features).toContain("context-1m-2025-08-07");
    for (const feature of ANTHROPIC_OAUTH_BETA_FEATURES) expect(features).toContain(feature);
    expect(features.filter((feature) => feature === "oauth-2025-04-20")).toHaveLength(1);
  });

  it("shares one refresh across concurrent requests and persists rotation", async () => {
    const store = await temporaryStore();
    await store.set(ANTHROPIC_PROVIDER_ID, {
      type: "oauth",
      access: "expired",
      refresh: "refresh-old",
      expires: 1,
    });
    const refreshStarted = deferred();
    const releaseRefresh = deferred();
    let refreshCalls = 0;
    let messageCalls = 0;
    const adapted = createAnthropicFetch({
      store,
      fetchImpl: async (input) => {
        if (String(input) === ANTHROPIC_TOKEN_ENDPOINT) {
          refreshCalls += 1;
          refreshStarted.resolve();
          await releaseRefresh.promise;
          return jsonResponse({
            access_token: "access-rotated",
            refresh_token: "refresh-rotated",
            expires_in: 3600,
          });
        }
        messageCalls += 1;
        return jsonResponse({ ok: true });
      },
    });

    const first = adapted("https://api.anthropic.com/v1/messages");
    await refreshStarted.promise;
    const second = adapted("https://api.anthropic.com/v1/messages");
    releaseRefresh.resolve();
    await Promise.all([first, second]);

    expect(refreshCalls).toBe(1);
    expect(messageCalls).toBe(2);
    expect(expectOauth(await store.get(ANTHROPIC_PROVIDER_ID))).toMatchObject({
      access: "access-rotated",
      refresh: "refresh-rotated",
    });
  });

  it("honors broker revocation before the next request", async () => {
    const store = await temporaryStore();
    await store.set(ANTHROPIC_PROVIDER_ID, {
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: Date.now() + 60_000,
    });
    let networkCalls = 0;
    const adapted = createAnthropicFetch({
      store,
      fetchImpl: async () => {
        networkCalls += 1;
        return jsonResponse({ ok: true });
      },
    });

    expect(await store.delete(ANTHROPIC_PROVIDER_ID)).toBe(true);
    await expect(adapted("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      `No oauth credential stored for "${ANTHROPIC_PROVIDER_ID}"`,
    );
    expect(networkCalls).toBe(0);
  });
});
