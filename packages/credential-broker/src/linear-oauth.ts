/**
 * Linear MCP OAuth 2.1 (authorization code + PKCE + dynamic client registration).
 *
 * This is the same authorization server Claude Code / Codex talk to at
 * `https://mcp.linear.app`. Tokens are Bearer credentials Linear also accepts
 * on `api.linear.app/graphql`.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { ProviderCredential } from "./credential-store.ts";

export const LINEAR_PROVIDER_ID = "linear";
export const LINEAR_MCP_RESOURCE = "https://mcp.linear.app/mcp";
export const LINEAR_OAUTH_ISSUER = "https://mcp.linear.app";
export const LINEAR_AUTHORIZE_ENDPOINT = "https://mcp.linear.app/authorize";
export const LINEAR_TOKEN_ENDPOINT = "https://mcp.linear.app/token";
export const LINEAR_REGISTER_ENDPOINT = "https://mcp.linear.app/register";
export const LINEAR_OAUTH_SCOPES = "read write";

const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const TOKEN_LIFETIME_FALLBACK_SECONDS = 3600;
const PKCE_VERIFIER_LENGTH = 64;

const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
});

const RegistrationSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
});

type OauthCredential = Extract<ProviderCredential, { type: "oauth" }>;

export function generateLinearPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(PKCE_VERIFIER_LENGTH).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildLinearAuthorizeUrl(input: {
  clientId: string;
  challenge: string;
  state: string;
  redirectUri: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: LINEAR_OAUTH_SCOPES,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
    resource: LINEAR_MCP_RESOURCE,
  });
  return `${LINEAR_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

export async function registerLinearOauthClient(
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ clientId: string; clientSecret?: string }> {
  const response = await fetchImpl(LINEAR_REGISTER_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Clankie",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: LINEAR_OAUTH_SCOPES,
    }),
  });
  if (!response.ok) {
    throw new Error(`Linear client registration failed: HTTP ${String(response.status)}`);
  }
  const parsed = RegistrationSchema.parse(await response.json());
  return {
    clientId: parsed.client_id,
    ...(parsed.client_secret === undefined ? {} : { clientSecret: parsed.client_secret }),
  };
}

export function linearCredentialFromTokens(
  tokens: z.infer<typeof TokenResponseSchema>,
  client: { clientId: string; clientSecret?: string },
  fallbackRefresh?: string,
): OauthCredential {
  const refresh = tokens.refresh_token ?? fallbackRefresh;
  if (refresh === undefined || refresh.length === 0) {
    throw new Error("Linear token response did not include a refresh_token");
  }
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh,
    expires: Date.now() + (tokens.expires_in ?? TOKEN_LIFETIME_FALLBACK_SECONDS) * 1000,
    clientId: client.clientId,
    ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
  };
}

export async function exchangeLinearAuthorizationCode(input: {
  code: string;
  redirectUri: string;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
}): Promise<OauthCredential> {
  const tokens = await requestLinearTokens(
    {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
      resource: LINEAR_MCP_RESOURCE,
      ...(input.clientSecret === undefined ? {} : { client_secret: input.clientSecret }),
    },
    input.fetchImpl ?? fetch,
    "Linear token exchange failed",
  );
  return linearCredentialFromTokens(tokens, {
    clientId: input.clientId,
    ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
  });
}

export async function refreshLinearOauth(
  credential: OauthCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<OauthCredential> {
  if (credential.refresh.length === 0) throw new Error("Linear OAuth credential has no refresh token");
  if (credential.clientId === undefined) throw new Error("Linear OAuth credential is missing client_id");
  const tokens = await requestLinearTokens(
    {
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: credential.clientId,
      resource: LINEAR_MCP_RESOURCE,
      ...(credential.clientSecret === undefined ? {} : { client_secret: credential.clientSecret }),
    },
    fetchImpl,
    "Linear token refresh failed",
  );
  return {
    ...linearCredentialFromTokens(
      tokens,
      {
        clientId: credential.clientId,
        ...(credential.clientSecret === undefined ? {} : { clientSecret: credential.clientSecret }),
      },
      credential.refresh,
    ),
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
  };
}

/** Refresh when the access token is inside a minute of expiry, or already expired. */
export function linearOauthNeedsRefresh(credential: OauthCredential, now = Date.now()): boolean {
  return credential.expires !== 0 && credential.expires < now + 60_000;
}

export interface LinearBrowserLoginOptions {
  port?: number;
  openUrl?: (url: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Browser sign-in against Linear's MCP authorization server. Binds a localhost
 * callback, dynamically registers this Clankie as a client, and returns an
 * oauth credential for the broker.
 */
export async function runLinearBrowserLogin(
  options: LinearBrowserLoginOptions = {},
): Promise<ProviderCredential> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const openUrl = options.openUrl ?? openWithDefaultBrowser;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const pkce = generateLinearPkce();
  const state = randomBytes(32).toString("base64url");

  return await new Promise<ProviderCredential>((resolve, reject) => {
    let redirectUri = "http://127.0.0.1/auth/callback";
    let clientId = "";
    let clientSecret: string | undefined;
    let settled = false;

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      settle();
    };
    const succeed = (credential: ProviderCredential): void => finish(() => resolve(credential));
    const fail = (error: Error): void => finish(() => reject(error));

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/auth/callback") {
        respond(response, 404, "text/plain", "Not found");
        return;
      }
      const error = url.searchParams.get("error");
      if (error !== null) {
        const message = url.searchParams.get("error_description") ?? error;
        respond(
          response,
          200,
          "text/html; charset=utf-8",
          loginResultPage("Linear sign-in failed", escapeHtml(message)),
        );
        fail(new Error(message));
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null || code.length === 0) {
        respond(
          response,
          400,
          "text/html; charset=utf-8",
          loginResultPage("Linear sign-in failed", "Missing authorization code"),
        );
        fail(new Error("Missing authorization code"));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        respond(
          response,
          400,
          "text/html; charset=utf-8",
          loginResultPage("Linear sign-in failed", "Invalid state"),
        );
        fail(new Error("Invalid OAuth state"));
        return;
      }
      respond(
        response,
        200,
        "text/html; charset=utf-8",
        loginResultPage("Linear connected", "You can close this window and return to Clankie."),
      );
      void exchangeLinearAuthorizationCode({
        code,
        redirectUri,
        verifier: pkce.verifier,
        clientId,
        ...(clientSecret === undefined ? {} : { clientSecret }),
        fetchImpl,
      })
        .then(succeed)
        .catch((cause: unknown) => fail(toError(cause)));
    });

    const timer = setTimeout(() => fail(new Error("Linear sign-in timed out")), timeoutMs);
    server.once("error", (error) => fail(error));
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = address !== null && typeof address === "object" ? address.port : (options.port ?? 0);
      redirectUri = `http://127.0.0.1:${String(boundPort)}/auth/callback`;
      void registerLinearOauthClient(redirectUri, fetchImpl)
        .then((client) => {
          clientId = client.clientId;
          clientSecret = client.clientSecret;
          openUrl(buildLinearAuthorizeUrl({ clientId, challenge: pkce.challenge, state, redirectUri }));
        })
        .catch((cause: unknown) => fail(toError(cause)));
    });
  });
}

async function requestLinearTokens(
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  failure: string,
): Promise<z.infer<typeof TokenResponseSchema>> {
  const response = await fetchImpl(LINEAR_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) throw new Error(`${failure}: HTTP ${String(response.status)}`);
  return TokenResponseSchema.parse(await response.json());
}

function openWithDefaultBrowser(url: string): void {
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.once("error", () => undefined);
  child.unref();
}

function respond(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "Content-Type": contentType, Connection: "close" });
  response.end(body);
}

function loginResultPage(heading: string, detail: string): string {
  return [
    "<!doctype html>",
    "<html>",
    `<head><meta charset="utf-8"><title>${heading}</title></head>`,
    '<body style="font-family: system-ui, sans-serif; text-align: center; padding: 4rem 1rem;">',
    `<h1>${heading}</h1>`,
    `<p>${detail}</p>`,
    "</body>",
    "</html>",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
