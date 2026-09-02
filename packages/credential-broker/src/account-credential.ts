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
  | "service_unavailable"
  | "unexpected_response";

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

export async function refreshClankieAccountCredential(
  credential: OauthCredential,
  config: PublicGatewayConfig,
  fetchImpl: typeof fetch = fetch,
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
    return credentialFromAuthentication(
      {
        ...response.AuthenticationResult,
        RefreshToken: response.AuthenticationResult.RefreshToken ?? credential.refresh,
      },
      config.account.clientId,
    );
  } catch (error) {
    throw mapCognitoError(error);
  }
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
    credential = await refreshClankieAccountCredential(credential, config, input.fetchImpl ?? fetch);
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
  throw error;
}

function isCognitoError(error: unknown, code: string): boolean {
  return error instanceof Error && "cognitoCode" in error && (error as CognitoError).cognitoCode === code;
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
  if (isCognitoError(error, "TooManyRequestsException") || isCognitoError(error, "LimitExceededException")) {
    return new ClankieAccountAuthError("rate_limited", "Too many code requests; wait a moment and try again");
  }
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
