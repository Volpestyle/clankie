import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createDefaultCredentialStore, type CredentialStore } from "./credential-store.ts";

export const OPERATOR_CREDENTIAL_PROVIDER_ID = "clankie_operator";
const OPERATOR_TOKEN_PREFIX = "clankie_op_";
const OPERATOR_TOKEN_BYTES = 32;
const OPERATOR_TOKEN_PATTERN = /^clankie_op_[A-Za-z0-9_-]{43}$/u;

export type OperatorCredentialConsistency = "missing" | "store_only" | "env_only" | "consistent" | "mismatch";

export interface OperatorCredentialStatus {
  readonly present: boolean;
  readonly source: "env" | "store" | "none";
  readonly consistency: OperatorCredentialConsistency;
}

export interface ResolvedOperatorCredential {
  readonly token: string;
  readonly source: "env" | "store";
  readonly status: OperatorCredentialStatus;
}

export type OperatorCredentialErrorCode =
  | "invalid_environment_override"
  | "invalid_stored_credential"
  | "missing"
  | "environment_override_active"
  | "store_unavailable";

export class OperatorCredentialError extends Error {
  public readonly code: OperatorCredentialErrorCode;

  public constructor(code: OperatorCredentialErrorCode, message: string) {
    super(message);
    this.name = "OperatorCredentialError";
    this.code = code;
  }
}

export interface OperatorCredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
}

interface MintOperatorCredentialOptions extends OperatorCredentialOptions {
  readonly randomBytes?: (size: number) => Buffer;
}

/** Mints a URL-safe operator bearer with 256 bits of cryptographic entropy. */
export function mintOperatorToken(random: (size: number) => Buffer = randomBytes): string {
  const entropy = random(OPERATOR_TOKEN_BYTES);
  if (entropy.length !== OPERATOR_TOKEN_BYTES) {
    throw new Error(`Operator credential entropy source must return ${OPERATOR_TOKEN_BYTES} bytes`);
  }
  return `${OPERATOR_TOKEN_PREFIX}${entropy.toString("base64url")}`;
}

/** Reads the effective token without creating one. The environment is an explicit override. */
export async function resolveOperatorCredential(
  options: OperatorCredentialOptions = {},
): Promise<ResolvedOperatorCredential | undefined> {
  const envToken = readEnvironmentToken(options.env ?? process.env);
  if (envToken !== undefined) {
    return {
      token: envToken,
      source: "env",
      status: { present: true, source: "env", consistency: "env_only" },
    };
  }
  const store = options.store ?? defaultStore(options.env);
  const storedToken = await readStoredToken(store);
  if (storedToken !== undefined) {
    return {
      token: storedToken,
      source: "store",
      status: { present: true, source: "store", consistency: "store_only" },
    };
  }
  return undefined;
}

/** First-run bootstrap. Persists a new token only when neither env nor store supplies one. */
export async function ensureOperatorCredential(
  options: MintOperatorCredentialOptions = {},
): Promise<ResolvedOperatorCredential> {
  const existing = await resolveOperatorCredential(options);
  if (existing !== undefined) return existing;
  const store = options.store ?? defaultStore(options.env);
  try {
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: mintOperatorToken(options.randomBytes),
    });
  } catch {
    throw new OperatorCredentialError(
      "store_unavailable",
      "Operator credential bootstrap could not update the credential store",
    );
  }
  // Read the durable value back. This makes the store authoritative if another
  // first-run process completed a write concurrently.
  const persisted = await resolveOperatorCredential({ ...options, store });
  if (persisted === undefined) {
    throw new OperatorCredentialError("missing", "Operator credential bootstrap did not persist a token");
  }
  return persisted;
}

/** Replaces the durable token. Active env overrides must be removed before rotation. */
export async function rotateOperatorCredential(
  options: MintOperatorCredentialOptions = {},
): Promise<ResolvedOperatorCredential> {
  if (readEnvironmentToken(options.env ?? process.env) !== undefined) {
    throw new OperatorCredentialError(
      "environment_override_active",
      "Operator credential rotation is unavailable while CLANKIE_OPERATOR_TOKEN overrides the store",
    );
  }
  const store = options.store ?? defaultStore(options.env);
  try {
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: mintOperatorToken(options.randomBytes),
    });
  } catch {
    throw new OperatorCredentialError(
      "store_unavailable",
      "Operator credential rotation could not update the credential store",
    );
  }
  const rotated = await resolveOperatorCredential({ ...options, store });
  if (rotated === undefined) {
    throw new OperatorCredentialError("missing", "Operator credential rotation did not persist a token");
  }
  return rotated;
}

/** Secret-free health projection. Safe for logs, JSON output, and support diagnostics. */
export async function inspectOperatorCredential(
  options: OperatorCredentialOptions = {},
): Promise<OperatorCredentialStatus> {
  const envToken = readEnvironmentToken(options.env ?? process.env);
  const store = options.store ?? defaultStore(options.env);
  const storedToken = await readStoredToken(store);
  return statusFor(envToken, storedToken);
}

function readEnvironmentToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.CLANKIE_OPERATOR_TOKEN;
  if (token === undefined) return undefined;
  if (token.length === 0) {
    throw new OperatorCredentialError(
      "invalid_environment_override",
      "CLANKIE_OPERATOR_TOKEN must not be empty",
    );
  }
  return token;
}

async function readStoredToken(store: CredentialStore): Promise<string | undefined> {
  const credential = await store.get(OPERATOR_CREDENTIAL_PROVIDER_ID);
  if (credential === undefined) return undefined;
  if (credential.type !== "api" || !OPERATOR_TOKEN_PATTERN.test(credential.key)) {
    throw new OperatorCredentialError(
      "invalid_stored_credential",
      "The stored operator credential is invalid; refusing to use it",
    );
  }
  return credential.key;
}

function statusFor(envToken: string | undefined, storedToken: string | undefined): OperatorCredentialStatus {
  if (envToken === undefined && storedToken === undefined) {
    return { present: false, source: "none", consistency: "missing" };
  }
  if (envToken === undefined) return { present: true, source: "store", consistency: "store_only" };
  if (storedToken === undefined) return { present: true, source: "env", consistency: "env_only" };
  return {
    present: true,
    source: "env",
    consistency: tokensEqual(envToken, storedToken) ? "consistent" : "mismatch",
  };
}

function tokensEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function defaultStore(env: NodeJS.ProcessEnv | undefined): CredentialStore {
  return createDefaultCredentialStore(env === undefined ? {} : { env });
}
