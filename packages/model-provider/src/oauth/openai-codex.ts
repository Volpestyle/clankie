import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { arch, platform, release } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { CredentialStore, ProviderCredential } from "@clankie/credential-broker";
import { z } from "zod";

/**
 * ChatGPT/Codex subscription OAuth for the {@link CODEX_PROVIDER_ID} provider.
 *
 * Ports opencode's Codex plugin: the browser flow (PKCE + localhost callback), the headless
 * device flow, refresh-token rotation, and the fetch adapter that reroutes Responses API
 * requests to the ChatGPT Codex backend with subscription headers.
 */

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
/**
 * Credential-store key for the ChatGPT subscription. Deliberately distinct from "openai"
 * so an OpenAI API key and the subscription credential can coexist in the same store.
 */
export const CODEX_PROVIDER_ID = "openai-codex";

const DEFAULT_OAUTH_PORT = 1455;
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3000;
/** RFC 8628 §3.5: on slow_down, grow the polling interval by 5 seconds. */
const DEVICE_SLOW_DOWN_INCREMENT_MS = 5000;
const TOKEN_LIFETIME_FALLBACK_SECONDS = 3600;
/**
 * Client-identity values sent to the Codex backend. They match opencode's, which the
 * backend is known to accept alongside the shared {@link CODEX_CLIENT_ID}.
 */
const CODEX_ORIGINATOR = "opencode";
const CODEX_CLIENT_VERSION = "1.0.0";

const PKCE_VERIFIER_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const PKCE_VERIFIER_LENGTH = 43;

const TokenResponseSchema = z.object({
  id_token: z.string().optional(),
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});
type TokenResponse = z.infer<typeof TokenResponseSchema>;

/** Lenient per-field parsing: one malformed claim must not hide a valid account id. */
const JwtClaimsSchema = z.object({
  chatgpt_account_id: z.string().optional().catch(undefined),
  organizations: z
    .array(z.object({ id: z.string() }))
    .optional()
    .catch(undefined),
  "https://api.openai.com/auth": z
    .object({ chatgpt_account_id: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

const DeviceAuthorizationSchema = z.object({
  device_auth_id: z.string(),
  user_code: z.string(),
  interval: z.union([z.string(), z.number()]).optional(),
});

const DeviceTokenSchema = z.object({
  authorization_code: z.string(),
  code_verifier: z.string(),
});

type OauthCredential = Extract<ProviderCredential, { type: "oauth" }>;

/** Generates a PKCE verifier/challenge pair (S256, base64url) with opencode's charset and length. */
export function generateCodexPkce(): { verifier: string; challenge: string } {
  const verifier = Array.from(randomBytes(PKCE_VERIFIER_LENGTH), (byte) =>
    PKCE_VERIFIER_CHARSET.charAt(byte % PKCE_VERIFIER_CHARSET.length),
  ).join("");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Builds the auth.openai.com authorize URL with the exact parameter set opencode sends. */
export function buildCodexAuthorizeUrl(input: {
  challenge: string;
  state: string;
  redirectUri: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: input.state,
    originator: CODEX_ORIGINATOR,
  });
  return `${CODEX_ISSUER}/oauth/authorize?${params.toString()}`;
}

/**
 * Decodes a JWT payload (base64url JSON, no signature verification) and returns the ChatGPT
 * account id: `chatgpt_account_id`, then `"https://api.openai.com/auth".chatgpt_account_id`,
 * then the first organization id — the same claim path opencode reads.
 */
export function extractCodexAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === "") return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return undefined;
  }
  const claims = JwtClaimsSchema.safeParse(payload);
  if (!claims.success) return undefined;
  return (
    claims.data.chatgpt_account_id ||
    claims.data["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.data.organizations?.[0]?.id ||
    undefined
  );
}

export interface CodexBrowserLoginOptions {
  /** Local callback port; 0 binds an ephemeral port. Defaults to 1455 (the registered Codex port). */
  port?: number;
  /** Receives the authorize URL. Defaults to macOS `open`; other platforms should supply their own. */
  openUrl?: (url: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Browser login: serves http://localhost:{port}/auth/callback, opens the authorize URL,
 * verifies the callback `state` (CSRF), exchanges the code (PKCE), and resolves an oauth
 * credential. The local server always shuts down — on success, failure, or timeout.
 */
export async function runCodexBrowserLogin(
  options: CodexBrowserLoginOptions = {},
): Promise<ProviderCredential> {
  const port = options.port ?? DEFAULT_OAUTH_PORT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const openUrl = options.openUrl ?? openWithDefaultBrowser;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const pkce = generateCodexPkce();
  const state = randomBytes(32).toString("base64url");

  return await new Promise<ProviderCredential>((resolve, reject) => {
    let redirectUri = `http://localhost:${port}/auth/callback`;
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
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        if (url.pathname === "/cancel") {
          respond(response, 200, "text/plain", "Login cancelled");
          fail(new Error("Login cancelled"));
          return;
        }
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
          loginResultPage("Login failed", escapeHtml(message)),
        );
        fail(new Error(message));
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null || code === "") {
        const message = "Missing authorization code";
        respond(response, 400, "text/html; charset=utf-8", loginResultPage("Login failed", message));
        fail(new Error(message));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        const message = "Invalid state - potential CSRF attack";
        respond(response, 400, "text/html; charset=utf-8", loginResultPage("Login failed", message));
        fail(new Error(message));
        return;
      }
      respond(
        response,
        200,
        "text/html; charset=utf-8",
        loginResultPage("Login successful", "You can close this window and return to the terminal."),
      );
      exchangeAuthorizationCode({ code, redirectUri, verifier: pkce.verifier, fetchImpl })
        .then((tokens) => succeed(credentialFromTokens(tokens)))
        .catch((cause: unknown) => fail(toError(cause)));
    });

    const timer = setTimeout(
      () => fail(new Error("OAuth callback timeout - authorization took too long")),
      timeoutMs,
    );

    server.once("error", (error) => fail(error));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = address !== null && typeof address === "object" ? address.port : port;
      redirectUri = `http://localhost:${boundPort}/auth/callback`;
      try {
        openUrl(buildCodexAuthorizeUrl({ challenge: pkce.challenge, state, redirectUri }));
      } catch (cause) {
        fail(toError(cause));
      }
    });
  });
}

export interface CodexDeviceLoginOptions {
  /** Receives the user code and the verification URL to show the user. */
  onUserCode: (code: string, verificationUrl: string) => void;
  fetchImpl?: typeof fetch;
  /** Overrides the server-suggested polling interval (and the slow_down increment) — for tests. */
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/**
 * Headless device login: requests a user code, then polls the device token endpoint until
 * authorized. 403/404 and `authorization_pending` keep polling; `slow_down` grows the
 * interval; any other failure aborts. Resolves an oauth credential.
 */
export async function runCodexDeviceLogin(options: CodexDeviceLoginOptions): Promise<ProviderCredential> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const response = await fetchImpl(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": deviceUserAgent() },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (!response.ok) throw new Error("Failed to initiate device authorization");
  const device = DeviceAuthorizationSchema.parse(await response.json());

  const serverIntervalMs = Math.max(Number.parseInt(String(device.interval ?? "5"), 10) || 5, 1) * 1000;
  let intervalMs = options.pollIntervalMs ?? serverIntervalMs + DEVICE_POLL_SAFETY_MARGIN_MS;
  const slowDownIncrementMs = options.pollIntervalMs ?? DEVICE_SLOW_DOWN_INCREMENT_MS;

  options.onUserCode(device.user_code, `${CODEX_ISSUER}/codex/device`);

  for (;;) {
    const poll = await fetchImpl(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": deviceUserAgent() },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
    });
    if (poll.ok) {
      const grant = DeviceTokenSchema.parse(await poll.json());
      const tokens = await exchangeAuthorizationCode({
        code: grant.authorization_code,
        redirectUri: `${CODEX_ISSUER}/deviceauth/callback`,
        verifier: grant.code_verifier,
        fetchImpl,
      });
      return credentialFromTokens(tokens);
    }
    const errorCode = await readErrorCode(poll);
    if (errorCode === "slow_down") {
      intervalMs += slowDownIncrementMs;
    } else if (errorCode !== "authorization_pending" && poll.status !== 403 && poll.status !== 404) {
      throw new Error(`Device authorization failed: ${poll.status}`);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("Device login timeout - authorization took too long");
    await sleep(Math.min(intervalMs, remainingMs));
  }
}

/**
 * Refresh-token grant against the Codex issuer. Preserves the existing accountId unless the
 * refreshed tokens carry a new account claim, and keeps the old refresh token when the
 * response omits one.
 */
export async function refreshCodexToken(
  credential: ProviderCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderCredential> {
  if (credential.type !== "oauth") {
    throw new Error(
      `Cannot refresh a "${credential.type}" credential; ${CODEX_PROVIDER_ID} uses oauth credentials`,
    );
  }
  return refreshOauthCredential(credential, fetchImpl);
}

export interface CodexFetchOptions {
  store: CredentialStore;
  fetchImpl?: typeof fetch;
  /** Sent as the `session-id` header when provided (one conversation/session per id). */
  sessionId?: string;
}

/**
 * Fetch adapter for subscription requests. Reads the {@link CODEX_PROVIDER_ID} credential
 * from the store, refreshes it once when expired (concurrent callers share a single
 * in-flight refresh, and the result is persisted back to the store), reroutes Responses API
 * and chat-completions requests to {@link CODEX_API_ENDPOINT}, strips any inbound
 * authorization header, and sets the subscription Bearer token plus the ChatGPT-Account-Id,
 * originator, User-Agent, and session-id headers the Codex backend expects.
 */
export function createCodexFetch(options: CodexFetchOptions): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  let refreshInFlight: Promise<OauthCredential> | undefined;

  const ensureFreshCredential = async (): Promise<OauthCredential> => {
    const stored = await options.store.get(CODEX_PROVIDER_ID);
    if (stored === undefined || stored.type !== "oauth") {
      throw new Error(`No oauth credential stored for "${CODEX_PROVIDER_ID}"; run a Codex login first`);
    }
    const expired = stored.access === "" || (stored.expires !== 0 && stored.expires <= Date.now());
    if (!expired) return stored;
    refreshInFlight ??= refreshOauthCredential(stored, fetchImpl)
      .then(async (next) => {
        await options.store.set(CODEX_PROVIDER_ID, next);
        return next;
      })
      .finally(() => {
        refreshInFlight = undefined;
      });
    return await refreshInFlight;
  };

  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const credential = await ensureFreshCredential();

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete("authorization");
    headers.set("authorization", `Bearer ${credential.access}`);
    if (credential.accountId !== undefined) headers.set("ChatGPT-Account-Id", credential.accountId);
    headers.set("originator", CODEX_ORIGINATOR);
    headers.set("User-Agent", chatUserAgent());
    if (options.sessionId !== undefined) headers.set("session-id", options.sessionId);

    const parsed = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    const url = isCodexRoutedPath(parsed.pathname) ? new URL(CODEX_API_ENDPOINT) : parsed;
    return fetchImpl(url, { ...init, headers });
  };
}

async function refreshOauthCredential(
  credential: OauthCredential,
  fetchImpl: typeof fetch,
): Promise<OauthCredential> {
  const tokens = await requestTokens(
    fetchImpl,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CODEX_CLIENT_ID,
    }),
    "Token refresh failed",
  );
  return credentialFromTokens(tokens, { refresh: credential.refresh, accountId: credential.accountId });
}

function exchangeAuthorizationCode(input: {
  code: string;
  redirectUri: string;
  verifier: string;
  fetchImpl: typeof fetch;
}): Promise<TokenResponse> {
  return requestTokens(
    input.fetchImpl,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: input.verifier,
    }),
    "Token exchange failed",
  );
}

async function requestTokens(
  fetchImpl: typeof fetch,
  body: URLSearchParams,
  failure: string,
): Promise<TokenResponse> {
  const response = await fetchImpl(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`${failure}: ${response.status}`);
  return TokenResponseSchema.parse(await response.json());
}

function credentialFromTokens(
  tokens: TokenResponse,
  fallback?: { refresh?: string | undefined; accountId?: string | undefined },
): OauthCredential {
  const refresh = tokens.refresh_token ?? fallback?.refresh;
  if (refresh === undefined) throw new Error("Token response did not include a refresh_token");
  const accountId = extractAccountIdFromTokens(tokens) ?? fallback?.accountId;
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh,
    expires: Date.now() + (tokens.expires_in ?? TOKEN_LIFETIME_FALLBACK_SECONDS) * 1000,
    ...(accountId !== undefined && { accountId }),
  };
}

function extractAccountIdFromTokens(tokens: TokenResponse): string | undefined {
  if (tokens.id_token !== undefined) {
    const accountId = extractCodexAccountId(tokens.id_token);
    if (accountId !== undefined) return accountId;
  }
  return extractCodexAccountId(tokens.access_token);
}

/** Matches opencode's rerouting rule, plus bare `/responses` paths from custom base URLs. */
function isCodexRoutedPath(pathname: string): boolean {
  return (
    pathname.endsWith("/responses") ||
    pathname.includes("/v1/responses") ||
    pathname.includes("/chat/completions")
  );
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (body !== null && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Non-JSON or empty bodies carry no device-flow error code; fall through to status handling.
  }
  return undefined;
}

function chatUserAgent(): string {
  return `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION} (${platform()} ${release()}; ${arch()})`;
}

function deviceUserAgent(): string {
  return `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`;
}

/** Default opener: macOS `open`. Launch failures surface as a callback timeout. */
function openWithDefaultBrowser(url: string): void {
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.once("error", () => {
    // Swallowed: the login promise still rejects via its timeout.
  });
  child.unref();
}

function respond(response: ServerResponse, status: number, contentType: string, body: string): void {
  // Connection: close reaps the socket after the flush, so server.close() completes promptly.
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
