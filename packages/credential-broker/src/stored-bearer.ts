import { randomBytes } from "node:crypto";
import { createDefaultCredentialStore, type CredentialStore } from "./credential-store.ts";

const STORED_BEARER_BYTES = 32;

interface StoredBearerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
}

type BootstrapErrorCode = "missing" | "store_unavailable";
type StoredBearerErrorCode = "invalid_stored_credential" | BootstrapErrorCode;
type StoredBearerErrorConstructor = new (code: StoredBearerErrorCode, message: string) => Error;

function mintStoredBearer(prefix: string, errorSubject: string, random: (size: number) => Buffer): string {
  const entropy = random(STORED_BEARER_BYTES);
  if (entropy.length !== STORED_BEARER_BYTES) {
    throw new Error(
      `${sentenceCase(errorSubject)} credential entropy source must return ${STORED_BEARER_BYTES} bytes`,
    );
  }
  return `${prefix}${entropy.toString("base64url")}`;
}

async function resolveStoredBearer(
  options: StoredBearerOptions,
  providerId: string,
  pattern: RegExp,
  errorSubject: string,
  ErrorClass: StoredBearerErrorConstructor,
): Promise<string | undefined> {
  const credential = await storeFor(options).get(providerId);
  if (credential === undefined) return undefined;
  if (credential.type !== "api" || !pattern.test(credential.key)) {
    throw new ErrorClass(
      "invalid_stored_credential",
      `The stored ${errorSubject} credential is invalid; refusing to use it`,
    );
  }
  return credential.key;
}

async function ensureStoredBearer<TOptions extends StoredBearerOptions>(
  options: TOptions,
  providerId: string,
  mint: () => string,
  resolve: (options: TOptions) => Promise<string | undefined>,
  errorSubject: string,
  ErrorClass: StoredBearerErrorConstructor,
): Promise<string> {
  const existing = await resolve(options);
  if (existing !== undefined) return existing;
  const store = storeFor(options);
  try {
    await store.set(providerId, { type: "api", key: mint() });
  } catch {
    throw new ErrorClass(
      "store_unavailable",
      `${sentenceCase(errorSubject)} credential bootstrap could not update the credential store`,
    );
  }
  const persisted = await resolve({ ...options, store });
  if (persisted === undefined) {
    throw new ErrorClass(
      "missing",
      `${sentenceCase(errorSubject)} credential bootstrap did not persist a token`,
    );
  }
  return persisted;
}

function storeFor(options: StoredBearerOptions): CredentialStore {
  return options.store ?? createDefaultCredentialStore(options.env === undefined ? {} : { env: options.env });
}

function sentenceCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * Mint/resolve/ensure triple for a broker-owned internal bearer. Callers keep
 * their public Error class and provider id; this is only the shared store path.
 */
export function defineBrokeredBearer<TError extends Error>(spec: {
  readonly providerId: string;
  readonly prefix: string;
  readonly pattern: RegExp;
  readonly mintSubject: string;
  readonly resolveSubject: string;
  readonly ErrorClass: StoredBearerErrorConstructor;
  readonly forbiddenEnv?: {
    readonly name: string;
    readonly throwForbidden: (envName: string) => TError;
  };
}): {
  mint(random?: (size: number) => Buffer): string;
  resolve(options?: StoredBearerOptions): Promise<string | undefined>;
  ensure(
    options?: StoredBearerOptions & { readonly randomBytes?: (size: number) => Buffer },
  ): Promise<string>;
  assertNoEnvironmentToken(env?: NodeJS.ProcessEnv): void;
} {
  const assertNoEnvironmentToken = (env: NodeJS.ProcessEnv = process.env): void => {
    if (spec.forbiddenEnv !== undefined && env[spec.forbiddenEnv.name]) {
      throw spec.forbiddenEnv.throwForbidden(spec.forbiddenEnv.name);
    }
  };
  const resolve = async (options: StoredBearerOptions = {}): Promise<string | undefined> => {
    assertNoEnvironmentToken(options.env ?? process.env);
    return resolveStoredBearer(options, spec.providerId, spec.pattern, spec.resolveSubject, spec.ErrorClass);
  };
  return {
    mint: (random = randomBytes) => mintStoredBearer(spec.prefix, spec.mintSubject, random),
    resolve,
    ensure: (options = {}) =>
      ensureStoredBearer(
        options,
        spec.providerId,
        () => mintStoredBearer(spec.prefix, spec.mintSubject, options.randomBytes ?? randomBytes),
        resolve,
        spec.resolveSubject,
        spec.ErrorClass,
      ),
    assertNoEnvironmentToken,
  };
}
