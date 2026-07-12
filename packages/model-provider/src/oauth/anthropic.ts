import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { CredentialStore, ProviderCredential } from "@clankie/credential-broker";
import { z } from "zod";

/**
 * Anthropic Claude Pro/Max subscription OAuth for captain model requests.
 *
 * This is the manual-code PKCE flow used by opencode before its Anthropic auth
 * plugin was removed. Anthropic redirects to its console, which presents an
 * authorization code for the operator to paste back into the client.
 */

export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_AUTHORIZE_ENDPOINT = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
export const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const ANTHROPIC_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

/** Required feature flags for Claude subscription requests. */
export const ANTHROPIC_OAUTH_BETA_FEATURES = [
  "oauth-2025-04-20",
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
] as const;

const TOKEN_LIFETIME_FALLBACK_SECONDS = 3600;
const PKCE_VERIFIER_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const PKCE_VERIFIER_LENGTH = 64;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
});
type TokenResponse = z.infer<typeof TokenResponseSchema>;
type OauthCredential = Extract<ProviderCredential, { type: "oauth" }>;

export interface AnthropicAuthorization {
  readonly url: string;
  readonly verifier: string;
  readonly state: string;
}

/** Generates an RFC 7636 S256 verifier/challenge pair. */
export function generateAnthropicPkce(): { verifier: string; challenge: string } {
  const verifier = Array.from(randomBytes(PKCE_VERIFIER_LENGTH), (byte) =>
    PKCE_VERIFIER_CHARSET.charAt(byte % PKCE_VERIFIER_CHARSET.length),
  ).join("");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** Builds the Claude Pro/Max authorization URL used by the manual-code flow. */
export function buildAnthropicAuthorizeUrl(input: { challenge: string; state: string }): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    scope: ANTHROPIC_OAUTH_SCOPES,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
  });
  return `${ANTHROPIC_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/** Creates the authorization URL plus the in-memory values needed for exchange. */
export function createAnthropicAuthorization(): AnthropicAuthorization {
  const pkce = generateAnthropicPkce();
  const state = randomBytes(32).toString("base64url");
  return {
    url: buildAnthropicAuthorizeUrl({ challenge: pkce.challenge, state }),
    verifier: pkce.verifier,
    state,
  };
}

export interface ExchangeAnthropicCodeOptions {
  /** The console's pasted value, formatted as `authorization-code#state`. */
  readonly code: string;
  readonly verifier: string;
  /** Original authorize-request state. The pasted state must match it. */
  readonly state: string;
  readonly fetchImpl?: typeof fetch;
}

/** Exchanges the pasted console code for a credential after validating OAuth state. */
export async function exchangeAnthropicCode(
  options: ExchangeAnthropicCodeOptions,
): Promise<ProviderCredential> {
  const { authorizationCode, returnedState } = parsePastedCode(options.code);
  if (returnedState !== options.state) {
    throw new Error("Invalid state - potential CSRF attack");
  }
  const tokens = await requestTokens(
    options.fetchImpl ?? fetch,
    {
      code: authorizationCode,
      state: returnedState,
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      code_verifier: options.verifier,
    },
    "Anthropic token exchange failed",
  );
  return credentialFromTokens(tokens);
}

export interface AnthropicBrowserLoginOptions {
  readonly store: CredentialStore;
  /** Reads the authorization code displayed by Anthropic after browser sign-in. */
  readonly readCode: (authorization: AnthropicAuthorization) => Promise<string>;
  /** Receives the URL instead of launching the default browser. */
  readonly openUrl?: (url: string) => void;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Runs the Claude Pro/Max browser flow and persists the resulting OAuth tokens
 * through the credential broker. No token is returned to the UI layer.
 */
export async function runAnthropicBrowserLogin(options: AnthropicBrowserLoginOptions): Promise<void> {
  const authorization = createAnthropicAuthorization();
  (options.openUrl ?? openWithDefaultBrowser)(authorization.url);
  const code = await options.readCode(authorization);
  const credential = await exchangeAnthropicCode({
    code,
    verifier: authorization.verifier,
    state: authorization.state,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  await options.store.set(ANTHROPIC_PROVIDER_ID, credential);
}

/** Refreshes an Anthropic subscription credential without mutating a store. */
export async function refreshAnthropicToken(
  credential: ProviderCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderCredential> {
  if (credential.type !== "oauth") {
    throw new Error(
      `Cannot refresh a "${credential.type}" credential; ${ANTHROPIC_PROVIDER_ID} subscription auth uses oauth credentials`,
    );
  }
  return refreshOauthCredential(credential, fetchImpl);
}

export interface AnthropicFetchOptions {
  readonly store: CredentialStore;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Creates the AI SDK fetch adapter for Claude subscription requests. It reads
 * the broker for every request (so local revocation is immediate), refreshes
 * expired credentials with a single in-flight grant, removes the SDK's API-key
 * placeholder, and attaches the subscription bearer and beta headers.
 */
export function createAnthropicFetch(options: AnthropicFetchOptions): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  let refreshInFlight: Promise<OauthCredential> | undefined;

  const ensureFreshCredential = async (): Promise<OauthCredential> => {
    const stored = await options.store.get(ANTHROPIC_PROVIDER_ID);
    if (stored === undefined || stored.type !== "oauth") {
      throw new Error(
        `No oauth credential stored for "${ANTHROPIC_PROVIDER_ID}"; run a Claude Pro/Max login first`,
      );
    }
    const expired = stored.access === "" || (stored.expires !== 0 && stored.expires <= Date.now());
    if (!expired) return stored;
    refreshInFlight ??= refreshOauthCredential(stored, fetchImpl)
      .then(async (next) => {
        await options.store.set(ANTHROPIC_PROVIDER_ID, next);
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
    headers.delete("x-api-key");
    headers.delete("authorization");
    headers.set("authorization", `Bearer ${credential.access}`);
    headers.set("anthropic-beta", mergeBetaFeatures(headers.get("anthropic-beta")));
    return fetchImpl(input, { ...init, headers });
  };
}

function parsePastedCode(value: string): { authorizationCode: string; returnedState: string } {
  const trimmed = value.trim();
  const separator = trimmed.indexOf("#");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error("Anthropic authorization code must include the returned state after '#'");
  }
  const authorizationCode = trimmed.slice(0, separator);
  const returnedState = trimmed.slice(separator + 1);
  if (returnedState.includes("#")) throw new Error("Anthropic authorization code is malformed");
  return { authorizationCode, returnedState };
}

async function refreshOauthCredential(
  credential: OauthCredential,
  fetchImpl: typeof fetch,
): Promise<OauthCredential> {
  const tokens = await requestTokens(
    fetchImpl,
    {
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    },
    "Anthropic token refresh failed",
  );
  return credentialFromTokens(tokens, credential.refresh);
}

async function requestTokens(
  fetchImpl: typeof fetch,
  body: Record<string, string>,
  failure: string,
): Promise<TokenResponse> {
  const response = await fetchImpl(ANTHROPIC_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${failure}: ${response.status}`);
  return TokenResponseSchema.parse(await response.json());
}

function credentialFromTokens(tokens: TokenResponse, fallbackRefresh?: string): OauthCredential {
  const refresh = tokens.refresh_token ?? fallbackRefresh;
  if (refresh === undefined) throw new Error("Anthropic token response did not include a refresh_token");
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh,
    expires: Date.now() + (tokens.expires_in ?? TOKEN_LIFETIME_FALLBACK_SECONDS) * 1000,
  };
}

function mergeBetaFeatures(existing: string | null): string {
  const features = new Set(
    (existing ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  for (const feature of ANTHROPIC_OAUTH_BETA_FEATURES) features.add(feature);
  return [...features].join(",");
}

/** Default opener for the repository's supported local macOS runtime. */
function openWithDefaultBrowser(url: string): void {
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.once("error", () => {
    // The URL is also available to the caller through readCode's authorization argument.
  });
  child.unref();
}
