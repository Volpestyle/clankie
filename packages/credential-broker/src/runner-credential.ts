import { randomBytes } from "node:crypto";
import { createDefaultCredentialStore, type CredentialStore } from "./credential-store.ts";

/**
 * The local bearer authenticating runner-scoped routes on the service.
 * Broker-owned for the same reason the bridge bearers are: an env-only token
 * dies with the shell that exported it. The service mints on first start.
 * `CLANKIE_RUNNER_TOKEN` in the environment still wins when set, so tests and
 * deliberate overrides keep working.
 */
export const RUNNER_CREDENTIAL_PROVIDER_ID = "clankie_runner";
const RUNNER_TOKEN_PREFIX = "clankie_runner_";
const RUNNER_TOKEN_BYTES = 32;
const RUNNER_TOKEN_PATTERN = /^clankie_runner_[A-Za-z0-9_-]{43}$/u;

export type RunnerCredentialErrorCode = "invalid_stored_credential" | "missing" | "store_unavailable";

export class RunnerCredentialError extends Error {
  public readonly code: RunnerCredentialErrorCode;

  public constructor(code: RunnerCredentialErrorCode, message: string) {
    super(message);
    this.name = "RunnerCredentialError";
    this.code = code;
  }
}

export interface RunnerCredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
}

interface MintRunnerCredentialOptions extends RunnerCredentialOptions {
  readonly randomBytes?: (size: number) => Buffer;
}

/** Mints the local bearer for runner-scoped routes on the service. */
export function mintRunnerToken(random: (size: number) => Buffer = randomBytes): string {
  const entropy = random(RUNNER_TOKEN_BYTES);
  if (entropy.length !== RUNNER_TOKEN_BYTES) {
    throw new Error(`Runner credential entropy source must return ${RUNNER_TOKEN_BYTES} bytes`);
  }
  return `${RUNNER_TOKEN_PREFIX}${entropy.toString("base64url")}`;
}

/** Reads the broker-owned runner bearer without exposing it through environment configuration. */
export async function resolveRunnerCredential(
  options: RunnerCredentialOptions = {},
): Promise<string | undefined> {
  const store = options.store ?? defaultStore(options.env);
  const credential = await store.get(RUNNER_CREDENTIAL_PROVIDER_ID);
  if (credential === undefined) return undefined;
  if (credential.type !== "api" || !RUNNER_TOKEN_PATTERN.test(credential.key)) {
    throw new RunnerCredentialError(
      "invalid_stored_credential",
      "The stored runner credential is invalid; refusing to use it",
    );
  }
  return credential.key;
}

/**
 * Service-owned first-run bootstrap: mints the credential when it is absent,
 * resolves it otherwise.
 */
export async function ensureRunnerCredential(options: MintRunnerCredentialOptions = {}): Promise<string> {
  const existing = await resolveRunnerCredential(options);
  if (existing !== undefined) return existing;
  const store = options.store ?? defaultStore(options.env);
  try {
    await store.set(RUNNER_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: mintRunnerToken(options.randomBytes),
    });
  } catch {
    throw new RunnerCredentialError(
      "store_unavailable",
      "Runner credential bootstrap could not update the credential store",
    );
  }
  const persisted = await resolveRunnerCredential({ ...options, store });
  if (persisted === undefined) {
    throw new RunnerCredentialError("missing", "Runner credential bootstrap did not persist a token");
  }
  return persisted;
}

function defaultStore(env: NodeJS.ProcessEnv | undefined): CredentialStore {
  return createDefaultCredentialStore(env === undefined ? {} : { env });
}
