import { randomBytes } from "node:crypto";
import type { CredentialStore } from "./credential-store.ts";
import { ensureStoredBearer, mintStoredBearer, resolveStoredBearer } from "./stored-bearer.ts";

/**
 * The local bearer authenticating runner-scoped routes on the service.
 * Broker-owned for the same reason the bridge bearers are: an env-only token
 * dies with the shell that exported it. The service mints on first start.
 * `CLANKIE_RUNNER_TOKEN` in the environment still wins when set, so tests and
 * deliberate overrides keep working.
 */
export const RUNNER_CREDENTIAL_PROVIDER_ID = "clankie_runner";
const RUNNER_TOKEN_PREFIX = "clankie_runner_";
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
  return mintStoredBearer(RUNNER_TOKEN_PREFIX, "runner", random);
}

/** Reads the broker-owned runner bearer without exposing it through environment configuration. */
export async function resolveRunnerCredential(
  options: RunnerCredentialOptions = {},
): Promise<string | undefined> {
  return resolveStoredBearer(
    options,
    RUNNER_CREDENTIAL_PROVIDER_ID,
    RUNNER_TOKEN_PATTERN,
    "runner",
    RunnerCredentialError,
  );
}

/**
 * Service-owned first-run bootstrap: mints the credential when it is absent,
 * resolves it otherwise.
 */
export async function ensureRunnerCredential(options: MintRunnerCredentialOptions = {}): Promise<string> {
  return ensureStoredBearer(
    options,
    RUNNER_CREDENTIAL_PROVIDER_ID,
    () => mintRunnerToken(options.randomBytes),
    resolveRunnerCredential,
    "runner",
    RunnerCredentialError,
  );
}
