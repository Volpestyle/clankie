import { createDefaultCredentialStore, type CredentialStore } from "./credential-store.ts";

const STORED_BEARER_BYTES = 32;

interface StoredBearerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
}

type BootstrapErrorCode = "missing" | "store_unavailable";
type StoredBearerErrorCode = "invalid_stored_credential" | BootstrapErrorCode;
type StoredBearerErrorConstructor = new (code: StoredBearerErrorCode, message: string) => Error;

export function mintStoredBearer(
  prefix: string,
  errorSubject: string,
  random: (size: number) => Buffer,
): string {
  const entropy = random(STORED_BEARER_BYTES);
  if (entropy.length !== STORED_BEARER_BYTES) {
    throw new Error(
      `${sentenceCase(errorSubject)} credential entropy source must return ${STORED_BEARER_BYTES} bytes`,
    );
  }
  return `${prefix}${entropy.toString("base64url")}`;
}

export async function resolveStoredBearer(
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

export async function ensureStoredBearer<TOptions extends StoredBearerOptions>(
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
