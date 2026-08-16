import { createDefaultCredentialStore, type CredentialStore } from "./credential-store.ts";

/** Operator-provisioned bearer for joining the hosted pokeagent-mmo world. */
export const WORLD_CREDENTIAL_PROVIDER_ID = "pokeagent_mmo_world";

/** Environment names that must never carry this credential. */
export const WORLD_CREDENTIAL_FORBIDDEN_ENV = "CLANKIE_WORLD_CREDENTIAL" as const;

export type WorldCredentialErrorCode =
  | "invalid_stored_credential"
  | "store_unavailable"
  | "environment_credential_forbidden";

export class WorldCredentialError extends Error {
  public readonly code: WorldCredentialErrorCode;

  public constructor(code: WorldCredentialErrorCode, message: string) {
    super(message);
    this.name = "WorldCredentialError";
    this.code = code;
  }
}

export interface WorldCredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
}

/** Refuse a weaker environment-supplied credential even when the broker also has one. */
export function assertNoEnvironmentWorldCredential(env: NodeJS.ProcessEnv = process.env): void {
  if (env[WORLD_CREDENTIAL_FORBIDDEN_ENV]) {
    throw new WorldCredentialError(
      "environment_credential_forbidden",
      `${WORLD_CREDENTIAL_FORBIDDEN_ENV} must not be set; the world credential lives in the credential broker`,
    );
  }
}

/** Reads the broker-owned world bearer. Returns undefined when the operator has not provisioned it. */
export async function resolveWorldCredential(
  options: WorldCredentialOptions = {},
): Promise<string | undefined> {
  assertNoEnvironmentWorldCredential(options.env ?? process.env);
  const store = options.store ?? defaultStore(options.env);
  let credential;
  try {
    credential = await store.get(WORLD_CREDENTIAL_PROVIDER_ID);
  } catch {
    throw new WorldCredentialError(
      "store_unavailable",
      "The credential broker could not read the hosted-world credential",
    );
  }
  if (credential === undefined) return undefined;
  if (credential.type !== "api" || credential.key.length < 32 || credential.key.length > 512) {
    throw new WorldCredentialError(
      "invalid_stored_credential",
      "The stored hosted-world credential is invalid; refusing to use it",
    );
  }
  return credential.key;
}

function defaultStore(env: NodeJS.ProcessEnv | undefined): CredentialStore {
  return createDefaultCredentialStore(env === undefined ? {} : { env });
}
