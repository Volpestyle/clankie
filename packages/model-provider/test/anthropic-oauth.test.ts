import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore, type ProviderCredential } from "@clankie/credential-broker";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTHROPIC_PROVIDER_ID,
  createAnthropicFetch,
  runAnthropicBrowserLogin,
} from "../src/oauth/anthropic.ts";

const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const REQUIRED_BETA_FEATURES = [
  "oauth-2025-04-20",
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
];

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
  it("opens the PKCE flow and persists exchanged tokens only through the broker", async () => {
    const store = await temporaryStore();
    let openedUrl = "";
    let request: { url: string; headers: Headers; body: Record<string, string> } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      request = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, string>,
      };
      return jsonResponse({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 900 });
    };

    await runAnthropicBrowserLogin({
      store,
      openUrl(url) {
        openedUrl = url;
      },
      async readCode(authorization) {
        const url = new URL(authorization.url);
        expect(authorization.url).toBe(openedUrl);
        expect(authorization.verifier).not.toBe(authorization.state);
        expect(`${url.origin}${url.pathname}`).toBe("https://claude.ai/oauth/authorize");
        expect(url.searchParams.get("code")).toBe("true");
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("redirect_uri")).toBe(
          "https://console.anthropic.com/oauth/code/callback",
        );
        expect(url.searchParams.get("code_challenge")).toBe(
          createHash("sha256").update(authorization.verifier).digest("base64url"),
        );
        expect(url.searchParams.get("state")).toBe(authorization.state);
        return `authorization-code#${authorization.state}`;
      },
      fetchImpl,
    });

    expect(request?.url).toBe(TOKEN_ENDPOINT);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.body).toMatchObject({
      code: "authorization-code",
      grant_type: "authorization_code",
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
    });
    expect(expectOauth(await store.get(ANTHROPIC_PROVIDER_ID))).toMatchObject({
      access: "access-new",
      refresh: "refresh-new",
    });
  });

  it("rejects a returned state before token exchange", async () => {
    const store = await temporaryStore();
    let calls = 0;

    await expect(
      runAnthropicBrowserLogin({
        store,
        openUrl: () => {},
        readCode: async () => "authorization-code#wrong-state",
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({});
        },
      }),
    ).rejects.toThrow("Invalid state");
    expect(calls).toBe(0);
  });
});

describe("Anthropic OAuth refresh and request adaptation", () => {
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
    for (const feature of REQUIRED_BETA_FEATURES) expect(features).toContain(feature);
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
    let refreshBody: Record<string, string> | undefined;
    let messageCalls = 0;
    const adapted = createAnthropicFetch({
      store,
      fetchImpl: async (input, init) => {
        if (String(input) === TOKEN_ENDPOINT) {
          refreshCalls += 1;
          refreshBody = JSON.parse(String(init?.body)) as Record<string, string>;
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
    expect(refreshBody).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-old",
    });
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
