import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

const CLOCK_SKEW_SECONDS = 60;
const JWKS_CACHE_MS = 60 * 60_000;
const JWKS_REFRESH_MINIMUM_MS = 60_000;

const JwtHeaderSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(256) }).passthrough();
const AccessClaimsSchema = z
  .object({
    client_id: z.string().min(1).max(128),
    exp: z.number().int().positive(),
    iat: z.number().int().positive().optional(),
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
}

type CognitoAccessTokenVerifier = (token: string) => Promise<CognitoAccessPrincipal>;

export function createCognitoAccessTokenVerifier(input: {
  readonly issuer: string;
  readonly clientId: string;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
}): CognitoAccessTokenVerifier {
  const issuer = requireIssuer(input.issuer);
  const clientId = input.clientId;
  if (!/^[A-Za-z0-9_+]{1,128}$/u.test(clientId)) throw new Error("Cognito client id is invalid");
  const fetchImpl = input.fetchImpl ?? fetch;
  const clock = input.clock ?? Date.now;
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
    if (claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS) throw new Error("Cognito access token expired");
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
    return { accountId: claims.sub, expiresAtMs: claims.exp * 1_000 };
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
