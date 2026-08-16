import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { CredentialStore, ProviderCredential } from "@clankie/credential-broker";
import { z } from "zod";

/**
 * SuperGrok / X Premium subscription OAuth for the {@link XAI_PROVIDER_ID} provider.
 *
 * Ports opencode's public Grok-CLI device-code client: RFC 8628 against
 * auth.x.ai, refresh-token rotation, and a fetch adapter that swaps the AI SDK
 * placeholder for the live Bearer token. Same provider id as an xAI API key —
 * storing OAuth displaces the key, Anthropic-style.
 */

export const XAI_PROVIDER_ID = "xai";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const XAI_OAUTH_SCOPES = "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_REFERRER = "opencode";

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000;
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;
const TOKEN_LIFETIME_FALLBACK_SECONDS = 3600;
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const XAI_USER_AGENT = "clankie/1.0.0";

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
});
type TokenResponse = z.infer<typeof TokenResponseSchema>;

const DeviceAuthorizationSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  interval: z.number().positive().optional(),
});

type OauthCredential = Extract<ProviderCredential, { type: "oauth" }>;

export interface XaiDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresInMs: number;
  readonly intervalMs: number;
}

/** Transport used by login, refresh, and the request adapter. Accepts `fetch` or media's narrower `MediaFetch`. */
export type XaiTransport = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RequestXaiDeviceCodeOptions {
  readonly fetchImpl?: XaiTransport;
}

/** Requests an RFC 8628 device code from auth.x.ai. */
export async function requestXaiDeviceCode(
  options: RequestXaiDeviceCodeOptions = {},
): Promise<XaiDeviceAuthorization> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(XAI_DEVICE_AUTHORIZATION_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPES,
      referrer: XAI_OAUTH_REFERRER,
    }).toString(),
  });
  if (!response.ok) throw new Error(`xAI device code request failed: ${String(response.status)}`);
  const device = DeviceAuthorizationSchema.parse(await response.json());
  return {
    deviceCode: device.device_code,
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    ...(device.verification_uri_complete === undefined
      ? {}
      : { verificationUriComplete: device.verification_uri_complete }),
    expiresInMs: positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS),
    intervalMs: Math.max(
      positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
      DEVICE_CODE_MIN_INTERVAL_MS,
    ),
  };
}

export interface XaiDeviceLoginOptions {
  /** Receives the user code and the verification URL to show the operator. */
  readonly onUserCode: (code: string, verificationUrl: string) => void;
  /** Receives the browser URL. Defaults to macOS `open`; pass a no-op for headless. */
  readonly openUrl?: (url: string) => void;
  readonly fetchImpl?: XaiTransport;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/**
 * SuperGrok device login: prints a short code, optionally opens the complete
 * verification URL, then polls until authorized. Resolves an oauth credential.
 */
export async function runXaiDeviceLogin(options: XaiDeviceLoginOptions): Promise<ProviderCredential> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const device = await requestXaiDeviceCode({ fetchImpl });
  const verificationUrl = device.verificationUriComplete ?? device.verificationUri;
  options.onUserCode(device.userCode, device.verificationUri);
  (options.openUrl ?? openWithDefaultBrowser)(verificationUrl);

  const deadline = Math.min(
    now() + device.expiresInMs,
    now() + (options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS),
  );
  let intervalMs = device.intervalMs;

  for (;;) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new Error("xAI device authorization timed out");
    const poll = await fetchImpl(XAI_TOKEN_URL, {
      method: "POST",
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: device.deviceCode,
      }).toString(),
    });
    if (poll.ok) return credentialFromTokens(TokenResponseSchema.parse(await poll.json()));
    const errorCode = await readErrorCode(poll);
    if (errorCode === "authorization_pending") {
      await wait(Math.min(intervalMs + DEVICE_POLL_SAFETY_MARGIN_MS, remainingMs));
      continue;
    }
    if (errorCode === "slow_down") {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
      await wait(Math.min(intervalMs + DEVICE_POLL_SAFETY_MARGIN_MS, remainingMs));
      continue;
    }
    if (errorCode === "access_denied" || errorCode === "authorization_denied") {
      throw new Error("xAI device authorization was denied");
    }
    if (errorCode === "expired_token") throw new Error("xAI device code expired - please re-run login");
    throw new Error(`xAI device token exchange failed: ${String(poll.status)}`);
  }
}

/** Refreshes a SuperGrok credential without mutating a store. */
export async function refreshXaiToken(
  credential: ProviderCredential,
  fetchImpl: XaiTransport = fetch,
): Promise<ProviderCredential> {
  if (credential.type !== "oauth") {
    throw new Error(
      `Cannot refresh a "${credential.type}" credential; ${XAI_PROVIDER_ID} subscription auth uses oauth credentials`,
    );
  }
  return refreshOauthCredential(credential, fetchImpl);
}

export interface XaiFetchOptions {
  readonly store: CredentialStore;
  readonly fetchImpl?: XaiTransport;
}

/**
 * AI SDK / media fetch adapter for SuperGrok requests. Reads the broker every
 * call, refreshes expired credentials once (concurrent callers share the grant),
 * and replaces any inbound Authorization with the live Bearer token.
 */
export function createXaiFetch(options: XaiFetchOptions): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  let refreshInFlight: Promise<OauthCredential> | undefined;

  const ensureFreshCredential = async (): Promise<OauthCredential> => {
    const stored = await options.store.get(XAI_PROVIDER_ID);
    if (stored === undefined || stored.type !== "oauth") {
      throw new Error(
        `No oauth credential stored for "${XAI_PROVIDER_ID}"; run a SuperGrok / X Premium login first`,
      );
    }
    if (!credentialNeedsRefresh(stored)) return stored;
    refreshInFlight ??= refreshOauthCredential(stored, fetchImpl)
      .then(async (next) => {
        await options.store.set(XAI_PROVIDER_ID, next);
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
    headers.set("User-Agent", XAI_USER_AGENT);
    const url = input instanceof Request ? input.url : input;
    return fetchImpl(url, { ...init, headers });
  };
}

/**
 * Unsigned JWT `exp` check used to refresh a little before expiry. Opaque
 * tokens return false so the stored `expires` field stays authoritative.
 */
export function xaiAccessTokenIsExpiring(
  token: string | undefined,
  skewMs: number = ACCESS_TOKEN_REFRESH_SKEW_MS,
): boolean {
  if (token === undefined || token.length === 0) return false;
  const parts = token.split(".");
  if (parts.length < 2 || parts[1] === undefined || parts[1] === "") return false;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (claims === null || typeof claims !== "object" || !("exp" in claims)) return false;
    const exp = claims.exp;
    if (typeof exp !== "number") return false;
    return exp * 1000 <= Date.now() + Math.max(0, skewMs);
  } catch {
    return false;
  }
}

function credentialNeedsRefresh(credential: OauthCredential): boolean {
  if (credential.access === "") return true;
  if (credential.expires !== 0 && credential.expires <= Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
    return true;
  }
  return xaiAccessTokenIsExpiring(credential.access);
}

async function refreshOauthCredential(
  credential: OauthCredential,
  fetchImpl: XaiTransport,
): Promise<OauthCredential> {
  const response = await fetchImpl(XAI_TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: XAI_OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) throw new Error(`xAI token refresh failed: ${String(response.status)}`);
  return credentialFromTokens(TokenResponseSchema.parse(await response.json()), credential.refresh);
}

function credentialFromTokens(tokens: TokenResponse, fallbackRefresh?: string): OauthCredential {
  const refresh = tokens.refresh_token ?? fallbackRefresh;
  if (refresh === undefined) throw new Error("xAI token response did not include a refresh_token");
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh,
    expires: Date.now() + (tokens.expires_in ?? TOKEN_LIFETIME_FALLBACK_SECONDS) * 1000,
  };
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": XAI_USER_AGENT,
  };
}

function positiveSecondsToMs(value: number | undefined, defaultMs: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value * 1000 : defaultMs;
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (body !== null && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Non-JSON bodies carry no device-flow error code.
  }
  return undefined;
}

function openWithDefaultBrowser(url: string): void {
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.once("error", () => {
    // The URL is also available through onUserCode.
  });
  child.unref();
}
