import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

const CLOCK_SKEW_SECONDS = 60;
const JWKS_CACHE_MS = 60 * 60_000;
const JWKS_REFRESH_MINIMUM_MS = 60_000;

const JwtHeaderSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(256) }).passthrough();
const AccessClaimsSchema = z
  .object({
    client_id: z.string().min(1).max(128),
    exp: z.number().int().positive(),
    iat: z.number().int().positive(),
    iss: z.string().min(1).max(512),
    nbf: z.number().int().positive().optional(),
    sub: z.string().min(1).max(2_048),
    token_use: z.literal("access"),
  })
  .passthrough();
const JwkSchema = z
  .object({
    alg: z.literal("RS256").optional(),
    e: z.string().min(1),
    kid: z.string().min(1).max(256),
    kty: z.literal("RSA"),
    n: z.string().min(1),
    use: z.literal("sig").optional(),
  })
  .passthrough();
const JwksSchema = z.object({ keys: z.array(JwkSchema).min(1).max(16) }).strict();

interface CognitoAccessPrincipal {
  readonly accountId: string;
  readonly expiresAtMs: number;
  readonly clientId?: string;
  /** Derived only after signature, issuer, audience and time verification. */
  readonly session?: { readonly id: string; readonly authEventId: string };
  /** `cognito:groups`, when the user belongs to any. */
  readonly groups?: readonly string[];
}

export class CognitoRevocationUnavailableError extends Error {
  constructor() {
    super("Cognito access token revocation check unavailable");
  }
}

export type CognitoAccessTokenVerifier = (token: string) => Promise<CognitoAccessPrincipal>;

export function createCognitoAccessTokenVerifier(input: {
  readonly issuer: string;
  readonly clientId: string;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  /** Web authorization must observe provider revocation, not just a JWT signature. */
  readonly checkRevocation?: boolean;
  /** Exact-token status cache; web authorization defaults to no cache. Capped at 30 seconds. */
  readonly revocationCacheMs?: number;
}): CognitoAccessTokenVerifier {
  const issuer = requireIssuer(input.issuer);
  if (input.checkRevocation && !/^cognito-idp\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/u.test(issuer.hostname)) {
    throw new Error("Revocation checks require an AWS Cognito issuer");
  }
  const clientId = input.clientId;
  if (!/^[A-Za-z0-9_+]{1,128}$/u.test(clientId)) throw new Error("Cognito client id is invalid");
  const fetchImpl = input.fetchImpl ?? fetch;
  const clock = input.clock ?? Date.now;
  const revocationCacheMs = input.revocationCacheMs ?? 0;
  if (!Number.isFinite(revocationCacheMs) || revocationCacheMs < 0 || revocationCacheMs > 30_000) {
    throw new Error("Cognito revocation cache must be between 0 and 30000 ms");
  }
  const statuses = new Map<string, { until: number; result: Promise<void> }>();
  const jwksUrl = new URL(`${issuer.pathname.replace(/\/$/u, "")}/.well-known/jwks.json`, issuer.origin);
  let cached: { readonly fetchedAt: number; readonly keys: ReadonlyMap<string, KeyObject> } | undefined;
  let loading: Promise<ReadonlyMap<string, KeyObject>> | undefined;

  const loadKeys = async (force = false): Promise<ReadonlyMap<string, KeyObject>> => {
    const now = clock();
    if (!force && cached !== undefined && now - cached.fetchedAt < JWKS_CACHE_MS) return cached.keys;
    if (loading !== undefined) return await loading;
    loading = (async () => {
      const response = await fetchImpl(jwksUrl, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Cognito JWKS request failed: HTTP ${String(response.status)}`);
      const parsed = JwksSchema.parse(await response.json());
      const keys = new Map<string, KeyObject>();
      for (const jwk of parsed.keys) {
        if ((jwk.alg !== undefined && jwk.alg !== "RS256") || (jwk.use !== undefined && jwk.use !== "sig"))
          continue;
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      }
      if (keys.size === 0) throw new Error("Cognito JWKS contains no RS256 signing key");
      cached = { fetchedAt: clock(), keys };
      return keys;
    })().finally(() => {
      loading = undefined;
    });
    return await loading;
  };

  return async (token) => {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] === undefined || parts[1] === undefined || parts[2] === undefined) {
      throw new Error("Cognito access token is malformed");
    }
    const header = JwtHeaderSchema.parse(parseJwtPart(parts[0]));
    const claims = AccessClaimsSchema.parse(parseJwtPart(parts[1]));
    if (claims.iss !== issuer.toString().replace(/\/$/u, "") || claims.client_id !== clientId) {
      throw new Error("Cognito access token names another issuer or client");
    }
    const nowSeconds = Math.floor(clock() / 1_000);
    if (claims.exp <= claims.iat || claims.exp - claims.iat > 3600) {
      throw new Error("Cognito access token lifetime must be at most 3600 seconds");
    }
    if (claims.exp <= nowSeconds) throw new Error("Cognito access token expired");
    if (claims.nbf !== undefined && claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) {
      throw new Error("Cognito access token is not active yet");
    }
    if (claims.iat !== undefined && claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
      throw new Error("Cognito access token was issued in the future");
    }

    let keys = await loadKeys();
    let key = keys.get(header.kid);
    if (key === undefined && cached !== undefined && clock() - cached.fetchedAt >= JWKS_REFRESH_MINIMUM_MS) {
      keys = await loadKeys(true);
      key = keys.get(header.kid);
    }
    if (key === undefined) throw new Error("Cognito access token names an unknown signing key");
    const signature = decodeJwtBytes(parts[2]);
    if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) {
      throw new Error("Cognito access token signature is invalid");
    }
    if (input.checkRevocation) {
      if (
        typeof claims.scope !== "string" ||
        !claims.scope.split(" ").includes("aws.cognito.signin.user.admin")
      ) {
        throw new Error("Cognito access token cannot be checked for revocation");
      }
      // GetUser observes Cognito revocation without IAM credentials. Key by the
      // exact signed token, never origin_jti: tokens in a family can expire at
      // different times. Hash keys so the cache does not retain raw bearers.
      const key = createHash("sha256").update(token).digest("hex");
      const now = clock();
      for (const [key, status] of statuses) {
        if (status.until <= now) statuses.delete(key);
      }
      let status = statuses.get(key);
      if (status === undefined) {
        const result = (async () => {
          let response: Response;
          try {
            response = await fetchImpl(new URL("/", issuer.origin), {
              method: "POST",
              headers: {
                "content-type": "application/x-amz-json-1.1",
                "x-amz-target": "AWSCognitoIdentityProviderService.GetUser",
              },
              body: JSON.stringify({ AccessToken: token }),
              redirect: "error",
              signal: AbortSignal.timeout(5_000),
              cache: "no-store",
            });
          } catch {
            throw new CognitoRevocationUnavailableError();
          }
          // Only a provider authentication refusal establishes invalidity.
          // Throttling, outages and malformed responses are unavailability.
          if (!response.ok) {
            const error = await response.json().catch(() => undefined);
            const type = z.object({ __type: z.string() }).safeParse(error);
            if (
              response.status === 400 &&
              type.success &&
              type.data.__type.split("#").at(-1) === "NotAuthorizedException"
            ) {
              throw new Error("Cognito access token revocation check failed");
            }
            throw new CognitoRevocationUnavailableError();
          }
          const user = z
            .object({ UserAttributes: z.array(z.object({ Name: z.string(), Value: z.string() })).max(100) })
            .safeParse(await response.json().catch(() => undefined));
          if (!user.success) throw new CognitoRevocationUnavailableError();
          const subjects = user.data.UserAttributes.filter((attribute) => attribute.Name === "sub");
          if (subjects.length !== 1 || subjects[0]?.Value !== claims.sub) {
            throw new Error("Cognito access token revocation check failed");
          }
        })();
        status = { until: Math.min(now + revocationCacheMs, claims.exp * 1000), result };
        // Bound memory as well as cache age. Eviction only causes a fresh check.
        if (statuses.size >= 10_000) statuses.delete(statuses.keys().next().value!);
        statuses.set(key, status);
      }
      await status.result;
    }
    // Groups are for the fleet's operator dashboard; everyone else ignores them.
    const groups = z.array(z.string().min(1).max(128)).max(100).safeParse(claims["cognito:groups"]);
    return {
      accountId: claims.sub,
      expiresAtMs: claims.exp * 1_000,
      clientId: claims.client_id,
      ...(() => {
        const family = z.string().min(1).max(256).safeParse(claims.origin_jti);
        const authTime = z
          .number()
          .int()
          .positive()
          .max(nowSeconds + CLOCK_SKEW_SECONDS)
          .safeParse(claims.auth_time);
        if (!family.success || !authTime.success) return {};
        const digest = (claim: string | number) =>
          createHash("sha256")
            .update(JSON.stringify([claims.iss, claims.client_id, claims.sub, claim]))
            .digest("base64url");
        return { session: { id: digest(family.data), authEventId: digest(authTime.data) } };
      })(),
      ...(groups.success ? { groups: groups.data } : {}),
    };
  };
}

function parseJwtPart(value: string): unknown {
  try {
    return JSON.parse(decodeJwtBytes(value).toString("utf8"));
  } catch {
    throw new Error("Cognito access token contains invalid JSON");
  }
}

function decodeJwtBytes(value: string): Buffer {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Cognito access token contains invalid base64url");
  }
  return Buffer.from(value, "base64url");
}

function requireIssuer(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname === "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("Cognito issuer must be an exact HTTPS issuer URL");
  }
  return parsed;
}
