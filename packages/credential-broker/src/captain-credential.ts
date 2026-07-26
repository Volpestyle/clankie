import { randomBytes } from "node:crypto";
import { createDefaultCredentialStore, type CredentialStore } from "./credential-store.ts";

/**
 * The captain's local bearer, brokered rather than hand-exported.
 *
 * The control plane mints its captain authenticator from `CLANKIE_CAPTAIN_TOKEN`
 * and captain-eve presents the same value, so it is one shared secret held by
 * two processes. Nothing was generating it: a launcher-started stack had it on
 * neither side, which left `authenticateConfiguredCaptain` undefined and every
 * captain call answering 401 — not only memory, but every mission tool the
 * captain has. Brokering it the way the operator and Discord bridge credentials
 * are already brokered makes a fresh machine work with no shell setup.
 *
 * The Discord bridge deliberately refuses this variable ({@link
 * apps/discord-bridge/src/index.ts}); its identity is `clankie_discord_bridge`.
 * Whoever injects this must keep it away from the bridge's environment.
 */
export const CAPTAIN_CREDENTIAL_PROVIDER_ID = "clankie_captain";
const CAPTAIN_TOKEN_PREFIX = "clankie_cap_";
const CAPTAIN_TOKEN_BYTES = 32;
const CAPTAIN_TOKEN_PATTERN = /^clankie_cap_[A-Za-z0-9_-]{43}$/u;

export interface ResolvedCaptainCredential {
  readonly token: string;
  readonly source: "env" | "store";
}

export type CaptainCredentialErrorCode =
  | "invalid_environment_override"
  | "invalid_stored_credential"
  | "missing"
  | "store_unavailable";

export class CaptainCredentialError extends Error {
  public readonly code: CaptainCredentialErrorCode;

  public constructor(code: CaptainCredentialErrorCode, message: string) {
    super(message);
    this.name = "CaptainCredentialError";
    this.code = code;
  }
}

export interface CaptainCredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
}

interface MintCaptainCredentialOptions extends CaptainCredentialOptions {
  readonly randomBytes?: (size: number) => Buffer;
}

/** Mints a URL-safe captain bearer with 256 bits of cryptographic entropy. */
export function mintCaptainToken(random: (size: number) => Buffer = randomBytes): string {
  const entropy = random(CAPTAIN_TOKEN_BYTES);
  if (entropy.length !== CAPTAIN_TOKEN_BYTES) {
    throw new Error(`Captain credential entropy source must return ${CAPTAIN_TOKEN_BYTES} bytes`);
  }
  return `${CAPTAIN_TOKEN_PREFIX}${entropy.toString("base64url")}`;
}

/** Reads the effective token without creating one. The environment is an explicit override. */
export async function resolveCaptainCredential(
  options: CaptainCredentialOptions = {},
): Promise<ResolvedCaptainCredential | undefined> {
  const envToken = readEnvironmentToken(options.env ?? process.env);
  if (envToken !== undefined) return { token: envToken, source: "env" };
  const storedToken = await readStoredToken(options.store ?? defaultStore(options.env));
  return storedToken === undefined ? undefined : { token: storedToken, source: "store" };
}

/** First-run bootstrap. Persists a new token only when neither env nor store supplies one. */
export async function ensureCaptainCredential(
  options: MintCaptainCredentialOptions = {},
): Promise<ResolvedCaptainCredential> {
  const existing = await resolveCaptainCredential(options);
  if (existing !== undefined) return existing;
  const store = options.store ?? defaultStore(options.env);
  try {
    await store.set(CAPTAIN_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: mintCaptainToken(options.randomBytes),
    });
  } catch {
    throw new CaptainCredentialError(
      "store_unavailable",
      "Captain credential bootstrap could not update the credential store",
    );
  }
  // Read the durable value back, so a concurrent first-run write wins
  // consistently rather than each process trusting the token it just minted.
  const persisted = await resolveCaptainCredential({ ...options, store });
  if (persisted === undefined) {
    throw new CaptainCredentialError("missing", "Captain credential bootstrap did not persist a token");
  }
  return persisted;
}

function readEnvironmentToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.CLANKIE_CAPTAIN_TOKEN;
  if (token === undefined) return undefined;
  if (token.length === 0) {
    throw new CaptainCredentialError(
      "invalid_environment_override",
      "CLANKIE_CAPTAIN_TOKEN must not be empty",
    );
  }
  return token;
}

async function readStoredToken(store: CredentialStore): Promise<string | undefined> {
  const credential = await store.get(CAPTAIN_CREDENTIAL_PROVIDER_ID);
  if (credential === undefined) return undefined;
  if (credential.type !== "api" || !CAPTAIN_TOKEN_PATTERN.test(credential.key)) {
    throw new CaptainCredentialError(
      "invalid_stored_credential",
      "The stored captain credential is invalid; refusing to use it",
    );
  }
  return credential.key;
}

function defaultStore(env: NodeJS.ProcessEnv | undefined): CredentialStore {
  return createDefaultCredentialStore(env === undefined ? {} : { env });
}
