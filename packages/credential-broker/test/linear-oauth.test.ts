import { describe, expect, it } from "vitest";
import {
  LINEAR_AUTHORIZE_ENDPOINT,
  LINEAR_MCP_RESOURCE,
  LINEAR_REGISTER_ENDPOINT,
  LINEAR_TOKEN_ENDPOINT,
  buildLinearAuthorizeUrl,
  exchangeLinearAuthorizationCode,
  generateLinearPkce,
  linearOauthNeedsRefresh,
  refreshLinearOauth,
  registerLinearOauthClient,
} from "../src/linear-oauth.ts";

describe("linear MCP OAuth", () => {
  it("builds an authorize URL with PKCE, scopes, and the MCP resource", () => {
    const pkce = generateLinearPkce();
    expect(pkce.verifier.length).toBeGreaterThan(20);
    expect(pkce.challenge).not.toBe(pkce.verifier);
    const url = new URL(
      buildLinearAuthorizeUrl({
        clientId: "client-1",
        challenge: pkce.challenge,
        state: "state-1",
        redirectUri: "http://127.0.0.1:9/auth/callback",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(LINEAR_AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("resource")).toBe(LINEAR_MCP_RESOURCE);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9/auth/callback");
  });

  it("registers a public client and exchanges the code", async () => {
    const seen: { url: string; body: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      seen.push({ url, body });
      if (url === LINEAR_REGISTER_ENDPOINT) {
        return Response.json({ client_id: "dyn-client" });
      }
      if (url === LINEAR_TOKEN_ENDPOINT) {
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("code=auth-code");
        expect(body).toContain("code_verifier=verifier");
        expect(body).toContain(`resource=${encodeURIComponent(LINEAR_MCP_RESOURCE)}`);
        return Response.json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
        });
      }
      throw new Error(`unexpected ${url}`);
    };

    await expect(registerLinearOauthClient("http://127.0.0.1:9/auth/callback", fetchImpl)).resolves.toEqual({
      clientId: "dyn-client",
    });
    await expect(
      exchangeLinearAuthorizationCode({
        code: "auth-code",
        redirectUri: "http://127.0.0.1:9/auth/callback",
        verifier: "verifier",
        clientId: "dyn-client",
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      clientId: "dyn-client",
    });
    expect(seen.map((entry) => entry.url)).toEqual([LINEAR_REGISTER_ENDPOINT, LINEAR_TOKEN_ENDPOINT]);
  });

  it("refreshes and keeps the previous refresh token when Linear omits a new one", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(LINEAR_TOKEN_ENDPOINT);
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      expect(String(init?.body)).toContain("refresh_token=refresh-old");
      return Response.json({ access_token: "access-2", expires_in: 1800 });
    };
    const refreshed = await refreshLinearOauth(
      {
        type: "oauth",
        access: "access-old",
        refresh: "refresh-old",
        expires: 1,
        clientId: "dyn-client",
        accountId: "Ada",
      },
      fetchImpl,
    );
    expect(refreshed.access).toBe("access-2");
    expect(refreshed.refresh).toBe("refresh-old");
    expect(refreshed.accountId).toBe("Ada");
    expect(linearOauthNeedsRefresh({ ...refreshed, expires: Date.now() + 10_000 })).toBe(true);
    expect(linearOauthNeedsRefresh({ ...refreshed, expires: Date.now() + 120_000 })).toBe(false);
  });
});
