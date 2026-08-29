import type { CredentialStore } from "./credential-store.ts";
import { defineBrokeredBearer } from "./stored-bearer.ts";

/**
 * Local bearer for the activity plane's frame producer endpoint (ADR 0047).
 *
 * The runner presents this to the activity server's loopback producer listener.
 * It follows the same rule as every other internal Clankie bearer: the token
 * lives in the broker store and is never read from environment configuration,
 * so it does not appear in shell history, `ps` output, or a `.env` file.
 */
export const ACTIVITY_PRODUCER_CREDENTIAL_PROVIDER_ID = "clankie_activity_producer";
const ACTIVITY_PRODUCER_TOKEN_PREFIX = "clankie_activity_producer_";
const ACTIVITY_PRODUCER_TOKEN_PATTERN = /^clankie_activity_producer_[A-Za-z0-9_-]{43}$/u;

/** Environment names that must never carry this token. */
export const ACTIVITY_PRODUCER_FORBIDDEN_ENV = "CLANKIE_ACTIVITY_PRODUCER_TOKEN" as const;

export type ActivityProducerCredentialErrorCode =
  | "invalid_stored_credential"
  | "missing"
  | "store_unavailable"
  | "environment_token_forbidden";

export class ActivityProducerCredentialError extends Error {
  public readonly code: ActivityProducerCredentialErrorCode;

  public constructor(code: ActivityProducerCredentialErrorCode, message: string) {
    super(message);
    this.name = "ActivityProducerCredentialError";
    this.code = code;
  }
}

export interface ActivityProducerCredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
}

const bearer = defineBrokeredBearer({
  providerId: ACTIVITY_PRODUCER_CREDENTIAL_PROVIDER_ID,
  prefix: ACTIVITY_PRODUCER_TOKEN_PREFIX,
  pattern: ACTIVITY_PRODUCER_TOKEN_PATTERN,
  mintSubject: "activity producer",
  resolveSubject: "activity producer",
  ErrorClass: ActivityProducerCredentialError,
  forbiddenEnv: {
    name: ACTIVITY_PRODUCER_FORBIDDEN_ENV,
    throwForbidden: (envName) =>
      new ActivityProducerCredentialError(
        "environment_token_forbidden",
        `${envName} must not be set; the activity producer bearer lives in the credential broker`,
      ),
  },
});

/** Mints the local bearer shared by the activity server and the runner sink. */
export const mintActivityProducerToken = bearer.mint;

/**
 * Refuse to start when the token is supplied through the environment. A process
 * that accepts both would silently prefer the weaker source.
 */
export const assertNoEnvironmentActivityProducerToken = bearer.assertNoEnvironmentToken;

/** Reads the broker-owned producer bearer. Returns undefined when unset. */
export const resolveActivityProducerCredential = bearer.resolve;

/**
 * Activity-server-owned first-run bootstrap. The server owns the listener, so it
 * owns the mint; the runner only ever resolves, which avoids a cross-process
 * mint race producing two different tokens.
 */
export const ensureActivityProducerCredential = bearer.ensure;
