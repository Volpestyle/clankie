import { randomBytes } from "node:crypto";
import {
  PUBLIC_GATEWAY_CONFIG_PATH,
  PublicGatewayConfigSchema,
  PublicGatewayInstallationIdSchema,
  type PublicGatewayConfig,
} from "@clankie/protocol/public-gateway";
import { z } from "zod";
import type { CredentialStore, ProviderCredential } from "./credential-store.ts";

export const CLANKIE_ACCOUNT_PROVIDER_ID = "clankie-account";
export { derivePublicGatewayHostId } from "@clankie/protocol/public-gateway";

const ACCESS_REFRESH_WINDOW_MS = 5 * 60_000;
const TOKEN_LIFETIME_FALLBACK_SECONDS = 3_600;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

type OauthCredential = Extract<ProviderCredential, { type: "oauth" }>;

const AuthenticationResultSchema = z
  .object({
    AccessToken: z.string().min(1),
    RefreshToken: z.string().min(1).optional(),
    ExpiresIn: z.number().int().positive().optional(),
  })
  .passthrough();

const ChallengeResponseSchema = z
  .object({
    ChallengeName: z.string().optional(),
    Session: z.string().min(1).optional(),
    AuthenticationResult: AuthenticationResultSchema.optional(),
  })
  .passthrough();

const SignUpResponseSchema = z.object({ Session: z.string().min(1) }).passthrough();
const ConfirmSignUpResponseSchema = z.object({ Session: z.string().min(1) }).passthrough();
const RefreshResponseSchema = z.object({ AuthenticationResult: AuthenticationResultSchema }).passthrough();
const AccessTokenClaimsSchema = z
  .object({
    sub: z.string().min(1).max(2_048),
    client_id: z.string().min(1).max(128),
    token_use: z.literal("access"),
  })
  .passthrough();

export type ClankieAccountAuthErrorCode =
  | "account_not_invited"
  | "code_invalid"
  | "code_expired"
  | "email_invalid"
  | "rate_limited"
  | "refresh_rejected"
  | "service_unavailable"
  | "unexpected_response";

/** Codes a retry cannot clear; everything else is worth another attempt. */
const SIGN_IN_REQUIRED_CODES = new Set<ClankieAccountAuthErrorCode>([
  "account_not_invited",
  "code_expired",
  "code_invalid",
  "email_invalid",
  "refresh_rejected",
  "unexpected_response",
]);

export class ClankieAccountAuthError extends Error {
  public readonly code: ClankieAccountAuthErrorCode;

  public constructor(code: ClankieAccountAuthErrorCode, message: string) {
    super(message);
    this.name = "ClankieAccountAuthError";
    this.code = code;
  }
}

export interface ClankieAccountLoginChallenge {
  readonly mode: "signin" | "signup";
  readonly email: string;
  readonly session: string;
  readonly config: PublicGatewayConfig;
}

export interface ClankieAccountAccessToken {
  readonly token: string;
  readonly accountId: string;
  readonly expiresAt: number;
}

export type ClankieAccountTokenProvider = () => Promise<ClankieAccountAccessToken>;

export function generatePublicGatewayInstallationId(): string {
  return PublicGatewayInstallationIdSchema.parse(randomBytes(16).toString("base64url"));
}

export async function discoverPublicGatewayAccount(
  gatewayUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicGatewayConfig> {
  const response = await fetchImpl(new URL(PUBLIC_GATEWAY_CONFIG_PATH, requireGatewayOrigin(gatewayUrl)), {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new ClankieAccountAuthError(
      "service_unavailable",
      `Clankie account discovery failed: HTTP ${String(response.status)}`,
    );
  }
  return PublicGatewayConfigSchema.parse(await response.json());
}

export async function beginClankieAccountLogin(input: {
  readonly gatewayUrl: string;
  readonly email: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<ClankieAccountLoginChallenge> {
  const email = normalizeEmail(input.email);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = await discoverPublicGatewayAccount(input.gatewayUrl, fetchImpl);

  if (config.account.selfSignUpEnabled) {
    try {
      const signup = SignUpResponseSchema.parse(
        await cognitoRequest(
          config,
          "SignUp",
          {
            ClientId: config.account.clientId,
            Username: email,
            UserAttributes: [{ Name: "email", Value: email }],
          },
          fetchImpl,
        ),
      );
      return { mode: "signup", email, session: signup.Session, config };
    } catch (error) {
      if (!isCognitoError(error, "UsernameExistsException")) throw mapCognitoError(error);
    }
  }

  try {
    const response = ChallengeResponseSchema.parse(
      await cognitoRequest(
        config,
        "InitiateAuth",
        {
          AuthFlow: "USER_AUTH",
          ClientId: config.account.clientId,
          AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "EMAIL_OTP" },
        },
        fetchImpl,
      ),
    );
    if (response.ChallengeName !== "EMAIL_OTP" || response.Session === undefined) {
      throw new ClankieAccountAuthError("unexpected_response", "Clankie account did not issue an email code");
    }
    return { mode: "signin", email, session: response.Session, config };
  } catch (error) {
    throw mapCognitoError(error);
  }
}

export async function completeClankieAccountLogin(input: {
  readonly challenge: ClankieAccountLoginChallenge;
  readonly code: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<OauthCredential> {
  const code = input.code.trim();
  if (!/^\d+$/u.test(code)) {
    throw new ClankieAccountAuthError("code_invalid", "Enter the numeric code from your email");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const { challenge } = input;
  const { config } = challenge;
  try {
    let authentication: z.infer<typeof AuthenticationResultSchema>;
    if (challenge.mode === "signup") {
      const confirmed = ConfirmSignUpResponseSchema.parse(
        await cognitoRequest(
          config,
          "ConfirmSignUp",
          {
            ClientId: config.account.clientId,
            Username: challenge.email,
            ConfirmationCode: code,
            Session: challenge.session,
          },
          fetchImpl,
        ),
      );
      const signedIn = ChallengeResponseSchema.parse(
        await cognitoRequest(
          config,
          "InitiateAuth",
          {
            AuthFlow: "USER_AUTH",
            ClientId: config.account.clientId,
            AuthParameters: { USERNAME: challenge.email },
            Session: confirmed.Session,
          },
          fetchImpl,
        ),
      );
      if (signedIn.AuthenticationResult === undefined) {
        throw new ClankieAccountAuthError("unexpected_response", "Clankie account sign-in did not finish");
      }
      authentication = signedIn.AuthenticationResult;
    } else {
      const signedIn = ChallengeResponseSchema.parse(
        await cognitoRequest(
          config,
          "RespondToAuthChallenge",
          {
            ChallengeName: "EMAIL_OTP",
            ClientId: config.account.clientId,
            Session: challenge.session,
            ChallengeResponses: { USERNAME: challenge.email, EMAIL_OTP_CODE: code },
          },
          fetchImpl,
        ),
      );
      if (signedIn.AuthenticationResult === undefined) {
        throw new ClankieAccountAuthError("unexpected_response", "Clankie account sign-in did not finish");
      }
      authentication = signedIn.AuthenticationResult;
    }
    return credentialFromAuthentication(authentication, config.account.clientId);
  } catch (error) {
    throw mapCognitoError(error);
  }
}

/**
 * The pool rotates refresh tokens, so the stored one dies the moment Cognito
 * answers. `persistRotation` writes the replacement before this function can
 * throw on anything else: a malformed access token must cost one retry, not
 * remote access until someone notices and runs the email wizard.
 */
export async function refreshClankieAccountCredential(
  credential: OauthCredential,
  config: PublicGatewayConfig,
  fetchImpl: typeof fetch = fetch,
  persistRotation?: (credential: OauthCredential) => Promise<void>,
): Promise<OauthCredential> {
  if (credential.clientId !== config.account.clientId) {
    throw new ClankieAccountAuthError(
      "unexpected_response",
      "Stored Clankie account belongs to another client",
    );
  }
  try {
    const response = RefreshResponseSchema.parse(
      await cognitoRequest(
        config,
        "GetTokensFromRefreshToken",
        { ClientId: config.account.clientId, RefreshToken: credential.refresh },
        fetchImpl,
      ),
    );
    const refresh = response.AuthenticationResult.RefreshToken ?? credential.refresh;
    if (refresh !== credential.refresh) await persistRotation?.({ ...credential, refresh });
    return credentialFromAuthentication(
      { ...response.AuthenticationResult, RefreshToken: refresh },
      config.account.clientId,
    );
  } catch (error) {
    throw mapRefreshError(error);
  }
}

/**
 * True when only a human can fix it. Retrying a rejected or revoked account
 * credential never succeeds, so a caller that loops on one is a doorway that
 * looks busy while staying shut.
 */
export function clankieAccountSignInRequired(error: unknown): boolean {
  return error instanceof ClankieAccountAuthError && SIGN_IN_REQUIRED_CODES.has(error.code);
}

export function createClankieAccountTokenProvider(input: {
  readonly gatewayUrl: string;
  readonly store: CredentialStore;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}): ClankieAccountTokenProvider {
  let resolving: Promise<ClankieAccountAccessToken> | undefined;
  return async () => {
    resolving ??= resolveClankieAccountAccessToken(input).finally(() => {
      resolving = undefined;
    });
    return await resolving;
  };
}

export async function revokeClankieAccountCredential(input: {
  readonly gatewayUrl: string;
  readonly store: CredentialStore;
  readonly fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const credential = await input.store.get(CLANKIE_ACCOUNT_PROVIDER_ID);
  if (credential === undefined) return false;
  if (credential.type !== "oauth" || credential.clientId === undefined) {
    throw new ClankieAccountAuthError("unexpected_response", "Stored Clankie account credential is invalid");
  }
  const config = await discoverPublicGatewayAccount(input.gatewayUrl, input.fetchImpl ?? fetch);
  if (credential.clientId !== config.account.clientId) {
    throw new ClankieAccountAuthError(
      "unexpected_response",
      "Stored Clankie account belongs to another client",
    );
  }
  await cognitoRequest(
    config,
    "RevokeToken",
    { ClientId: credential.clientId, Token: credential.refresh },
    input.fetchImpl ?? fetch,
  );
  return await input.store.delete(CLANKIE_ACCOUNT_PROVIDER_ID);
}

async function resolveClankieAccountAccessToken(input: {
  readonly gatewayUrl: string;
  readonly store: CredentialStore;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}): Promise<ClankieAccountAccessToken> {
  const now = input.now?.() ?? Date.now();
  const stored = await input.store.get(CLANKIE_ACCOUNT_PROVIDER_ID);
  if (stored === undefined || stored.type !== "oauth" || stored.accountId === undefined) {
    throw new ClankieAccountAuthError("account_not_invited", "Sign in to your Clankie account first");
  }
  let credential = stored;
  if (credential.expires < now + ACCESS_REFRESH_WINDOW_MS) {
    const config = await discoverPublicGatewayAccount(input.gatewayUrl, input.fetchImpl ?? fetch);
    credential = await refreshClankieAccountCredential(
      credential,
      config,
      input.fetchImpl ?? fetch,
      (rotated) => input.store.set(CLANKIE_ACCOUNT_PROVIDER_ID, rotated),
    );
    await input.store.set(CLANKIE_ACCOUNT_PROVIDER_ID, credential);
  }
  if (credential.accountId === undefined) {
    throw new ClankieAccountAuthError("unexpected_response", "Clankie account token has no subject");
  }
  return { token: credential.access, accountId: credential.accountId, expiresAt: credential.expires };
}

function credentialFromAuthentication(
  authentication: z.infer<typeof AuthenticationResultSchema>,
  clientId: string,
): OauthCredential {
  const refresh = authentication.RefreshToken;
  if (refresh === undefined) {
    throw new ClankieAccountAuthError("unexpected_response", "Clankie account did not issue a refresh token");
  }
  const claims = parseAccessTokenClaims(authentication.AccessToken);
  if (claims.client_id !== clientId) {
    throw new ClankieAccountAuthError("unexpected_response", "Clankie account token names another client");
  }
  return {
    type: "oauth",
    access: authentication.AccessToken,
    refresh,
    expires: Date.now() + (authentication.ExpiresIn ?? TOKEN_LIFETIME_FALLBACK_SECONDS) * 1_000,
    accountId: claims.sub,
    clientId,
  };
}

function parseAccessTokenClaims(token: string): z.infer<typeof AccessTokenClaimsSchema> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) {
    throw new ClankieAccountAuthError(
      "unexpected_response",
      "Clankie account returned a malformed access token",
    );
  }
  try {
    return AccessTokenClaimsSchema.parse(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    throw new ClankieAccountAuthError(
      "unexpected_response",
      "Clankie account returned invalid access claims",
    );
  }
}

interface CognitoError extends Error {
  readonly cognitoCode: string;
  readonly status: number;
}

async function cognitoRequest(
  config: PublicGatewayConfig,
  operation: string,
  body: Readonly<Record<string, unknown>>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(config.account.endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${operation}`,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const raw = (await response.json().catch(() => ({}))) as { __type?: unknown; message?: unknown };
  if (response.ok) return raw;
  const headerCode = response.headers.get("x-amzn-errortype")?.split(":", 1)[0];
  const bodyCode = typeof raw.__type === "string" ? raw.__type.split("#").at(-1) : undefined;
  const error = new Error(
    typeof raw.message === "string" ? raw.message : "Cognito request failed",
  ) as CognitoError;
  Object.defineProperty(error, "cognitoCode", { value: headerCode ?? bodyCode ?? "UnknownError" });
  Object.defineProperty(error, "status", { value: response.status });
  throw error;
}

function isCognitoError(error: unknown, code: string): boolean {
  return error instanceof Error && "cognitoCode" in error && (error as CognitoError).cognitoCode === code;
}

const RATE_LIMITED_MESSAGE = "Too many attempts; try again in a few minutes";

/**
 * The accounts stack refuses too many attempts in two shapes, and both mean
 * "wait", never "sign in again" (clankie-ops accounts README, "Clients"):
 * - per IP, AWS WAF on the pool answers HTTP 429. Its body is Cognito-shaped
 *   today, but any 429 is a rate limit, whatever the body says.
 * - per email or domain, the limiter trigger throws `rate_limited`, which
 *   Cognito returns as HTTP 400 `UserLambdaValidationException` with the
 *   message `<Trigger> failed with error rate_limited.`
 * Cognito's own throttles (`TooManyRequestsException`, `LimitExceededException`)
 * mean the same.
 */
function isRateLimited(error: unknown): boolean {
  if (!(error instanceof Error) || !("cognitoCode" in error)) return false;
  const cognito = error as CognitoError;
  return (
    cognito.status === 429 ||
    cognito.cognitoCode === "TooManyRequestsException" ||
    cognito.cognitoCode === "LimitExceededException" ||
    (cognito.cognitoCode === "UserLambdaValidationException" && /\brate_limited\b/u.test(cognito.message))
  );
}

/**
 * An answer from Cognito is about this Mac's credential, not the weather.
 * Rotation revokes the whole chain when it sees a spent refresh token, so every
 * later attempt presents the same dead one: only a rate limit or Cognito's own
 * failure is worth retrying. A sign-in error class is not enumerated by name
 * here because the pool adds them (`Refresh token reuse detected` arrives with
 * no mapped type and must not read as a passing outage).
 */
function mapRefreshError(error: unknown): ClankieAccountAuthError {
  if (error instanceof ClankieAccountAuthError) return error;
  if (
    isRateLimited(error) ||
    isCognitoError(error, "InternalErrorException") ||
    isCognitoError(error, "ServiceUnavailableException")
  ) {
    return mapCognitoError(error);
  }
  if (error instanceof Error && "cognitoCode" in error) {
    return new ClankieAccountAuthError(
      "refresh_rejected",
      `Clankie account refused this Mac's refresh token: ${error.message}`,
    );
  }
  return mapCognitoError(error);
}

function mapCognitoError(error: unknown): ClankieAccountAuthError {
  if (error instanceof ClankieAccountAuthError) return error;
  if (isCognitoError(error, "CodeMismatchException")) {
    return new ClankieAccountAuthError("code_invalid", "That email code is not valid");
  }
  if (isCognitoError(error, "ExpiredCodeException")) {
    return new ClankieAccountAuthError("code_expired", "That email code expired; request another one");
  }
  if (isCognitoError(error, "UserNotFoundException") || isCognitoError(error, "NotAuthorizedException")) {
    return new ClankieAccountAuthError("account_not_invited", "This email does not have Clankie access yet");
  }
  if (isRateLimited(error)) return new ClankieAccountAuthError("rate_limited", RATE_LIMITED_MESSAGE);
  return new ClankieAccountAuthError(
    "service_unavailable",
    error instanceof Error ? error.message : "Clankie account service is unavailable",
  );
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw new ClankieAccountAuthError("email_invalid", "Enter a valid email address");
  }
  return email;
}

function requireGatewayOrigin(value: string): URL {
  const parsed = new URL(value);
  const loopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("Gateway URL must be an exact HTTPS origin (HTTP is loopback-only)");
  }
  return parsed;
}
