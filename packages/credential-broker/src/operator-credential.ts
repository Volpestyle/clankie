import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createDefaultCredentialStore,
  KeychainLockedError,
  type CredentialStore,
} from "./credential-store.ts";
import {
  ensureProtectedKeychain,
  hasProtectedKeychain,
  protectedKeychainPath,
  ProtectedKeychainStore,
} from "./protected-keychain.ts";

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
  | "store_unavailable"
  | "worker_pane";

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
  /** Exactly this store, unless `protectedFirst` also asks for the protected keychain. */
  readonly store?: CredentialStore;
  /**
   * Read and write the protected keychain ahead of `store` once it exists (VUH-2592).
   * The service sets it beside its general broker; without a store it is implied.
   */
  readonly protectedFirst?: boolean;
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

/** Set in a hired worker pane's environment; it selects the error, the OS profile is the boundary. */
function inWorkerPane(env: NodeJS.ProcessEnv): boolean {
  return env.CLANKIE_WORKER_PANE === "1";
}

function workerPaneError(): OperatorCredentialError {
  return new OperatorCredentialError(
    "worker_pane",
    "Hired workers don't hold the owner's operator credential (VUH-2592). Use your Clankie tools, or ask your lead.",
  );
}

/** One per keychain and process, so a per-request authenticator unlocks it once. */
const protectedStores = new Map<string, ProtectedKeychainStore>();
function protectedStore(env: NodeJS.ProcessEnv): ProtectedKeychainStore {
  const key = `${protectedKeychainPath(env)}\0${env.CLANKIE_PROTECTED_KEYCHAIN_PASSWORDS ?? ""}`;
  let store = protectedStores.get(key);
  if (!store) {
    store = new ProtectedKeychainStore({ env });
    protectedStores.set(key, store);
  }
  return store;
}

/**
 * Where the operator credential lives, in read order. An injected store is used as
 * given. Otherwise, and for the service's broker with `protectedFirst`, the protected
 * keychain comes first once it exists and receives every write; the broker copy is
 * then only a pre-migration fallback, never re-created.
 */
function operatorStores(options: OperatorCredentialOptions): readonly CredentialStore[] {
  if (options.store && options.protectedFirst !== true) return [options.store];
  const env = options.env ?? process.env;
  const legacy = options.store ?? defaultStore(options.env);
  return hasProtectedKeychain(env) ? [protectedStore(env), legacy] : [legacy];
}

/** Reads the effective token without creating one. The environment is an explicit override. */
export async function resolveOperatorCredential(
  options: OperatorCredentialOptions = {},
): Promise<ResolvedOperatorCredential | undefined> {
  const env = options.env ?? process.env;
  const envToken = readEnvironmentToken(env);
  if (envToken !== undefined) {
    return {
      token: envToken,
      source: "env",
      status: { present: true, source: "env", consistency: "env_only" },
    };
  }
  for (const store of operatorStores(options)) {
    let storedToken: string | undefined;
    try {
      storedToken = await readStoredToken(store);
    } catch (error) {
      // A worker's sandbox denies the protected store; that is the boundary, not a fault.
      if (inWorkerPane(env)) continue;
      throw error;
    }
    if (storedToken !== undefined) {
      return {
        token: storedToken,
        source: "store",
        status: { present: true, source: "store", consistency: "store_only" },
      };
    }
  }
  if (inWorkerPane(env)) throw workerPaneError();
  return undefined;
}

/** First-run bootstrap. Persists a new token only when neither env nor store supplies one. */
export async function ensureOperatorCredential(
  options: MintOperatorCredentialOptions = {},
): Promise<ResolvedOperatorCredential> {
  const existing = await resolveOperatorCredential(options);
  if (existing !== undefined) return existing;
  const store = operatorStores(options)[0]!;
  try {
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: mintOperatorToken(options.randomBytes),
    });
  } catch (error) {
    if (error instanceof KeychainLockedError) throw error;
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
  if (inWorkerPane(options.env ?? process.env)) throw workerPaneError();
  const store = operatorStores(options)[0]!;
  try {
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: mintOperatorToken(options.randomBytes),
    });
  } catch (error) {
    if (error instanceof KeychainLockedError) throw error;
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
  let storedToken: string | undefined;
  for (const store of operatorStores(options)) {
    storedToken = await readStoredToken(store);
    if (storedToken !== undefined) break;
  }
  return statusFor(envToken, storedToken);
}

interface ProtectOperatorCredentialResult {
  /** The protected keychain was created by this call. */
  readonly created: boolean;
  /** The login-keychain copy was moved; false when it was already protected. */
  readonly moved: boolean;
}

/**
 * Moves the operator credential from the login keychain into the protected keychain
 * (VUH-2592), deleting the login copy only after the protected copy reads back.
 * The token is unchanged, so running sessions keep working. Owner terminal only.
 */
export async function protectOperatorCredential(
  options: OperatorCredentialOptions = {},
): Promise<ProtectOperatorCredentialResult> {
  const env = options.env ?? process.env;
  if (inWorkerPane(env)) throw workerPaneError();
  if (process.platform !== "darwin")
    throw new OperatorCredentialError("store_unavailable", "The protected keychain needs macOS");
  const created = await ensureProtectedKeychain({ env });
  const target = protectedStore(env);
  const legacy = options.store ?? defaultStore(options.env);
  const legacyToken = await readStoredToken(legacy);
  if (legacyToken === undefined) {
    if ((await readStoredToken(target)) !== undefined) return { created, moved: false };
    throw new OperatorCredentialError("missing", "No stored operator credential to protect");
  }
  await target.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: legacyToken });
  const copied = await readStoredToken(target);
  if (copied === undefined || !tokensEqual(copied, legacyToken))
    throw new OperatorCredentialError(
      "store_unavailable",
      "The protected copy did not read back; the login-keychain copy is kept",
    );
  await legacy.delete(OPERATOR_CREDENTIAL_PROVIDER_ID);
  return { created, moved: true };
}

function readEnvironmentToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.CLANKIE_OPERATOR_TOKEN;
  if (token === undefined) return undefined;
  // A hired pane's environment blanks bearers it may have inherited from Herdr's server.
  if (token.length === 0 && inWorkerPane(env)) return undefined;
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
