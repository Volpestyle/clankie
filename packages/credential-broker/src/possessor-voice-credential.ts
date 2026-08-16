import { randomBytes } from "node:crypto";
import type { CredentialStore } from "./credential-store.ts";
import { ensureStoredBearer, mintStoredBearer, resolveStoredBearer } from "./stored-bearer.ts";

/**
 * Local bearer for the possessor voice seam (ADR 0064).
 *
 * A possessor holds no Discord gateway, so it cannot speak or hear directly. It
 * presents this bearer to the bridge's loopback possessor listener, and the
 * bridge — which does hold the gateway and the live presence claim — speaks and
 * pushes what it already heard.
 *
 * Same rule as every other internal Clankie bearer: the token lives in the
 * broker store and is never read from environment configuration, so it does not
 * appear in shell history, `ps` output, or a `.env` file.
 */
export const POSSESSOR_VOICE_CREDENTIAL_PROVIDER_ID = "clankie_possessor_voice";
const POSSESSOR_VOICE_TOKEN_PREFIX = "clankie_possessor_voice_";
const POSSESSOR_VOICE_TOKEN_PATTERN = /^clankie_possessor_voice_[A-Za-z0-9_-]{43}$/u;

/** Environment names that must never carry this token. */
export const POSSESSOR_VOICE_FORBIDDEN_ENV = "CLANKIE_POSSESSOR_VOICE_TOKEN" as const;

export type PossessorVoiceCredentialErrorCode =
  | "invalid_stored_credential"
  | "missing"
  | "store_unavailable"
  | "environment_token_forbidden";

export class PossessorVoiceCredentialError extends Error {
  public readonly code: PossessorVoiceCredentialErrorCode;

  public constructor(code: PossessorVoiceCredentialErrorCode, message: string) {
    super(message);
    this.name = "PossessorVoiceCredentialError";
    this.code = code;
  }
}

export interface PossessorVoiceCredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
}

interface MintPossessorVoiceCredentialOptions extends PossessorVoiceCredentialOptions {
  readonly randomBytes?: (size: number) => Buffer;
}

/** Mints the local bearer shared by the bridge listener and the possessor client. */
export function mintPossessorVoiceToken(random: (size: number) => Buffer = randomBytes): string {
  return mintStoredBearer(POSSESSOR_VOICE_TOKEN_PREFIX, "possessor voice", random);
}

/**
 * Refuse to start when the token is supplied through the environment. A process
 * that accepts both would silently prefer the weaker source.
 */
export function assertNoEnvironmentPossessorVoiceToken(env: NodeJS.ProcessEnv = process.env): void {
  if (env[POSSESSOR_VOICE_FORBIDDEN_ENV]) {
    throw new PossessorVoiceCredentialError(
      "environment_token_forbidden",
      `${POSSESSOR_VOICE_FORBIDDEN_ENV} must not be set; the possessor voice bearer lives in the credential broker`,
    );
  }
}

/** Reads the broker-owned possessor bearer. Returns undefined when unset. */
export async function resolvePossessorVoiceCredential(
  options: PossessorVoiceCredentialOptions = {},
): Promise<string | undefined> {
  assertNoEnvironmentPossessorVoiceToken(options.env ?? process.env);
  return resolveStoredBearer(
    options,
    POSSESSOR_VOICE_CREDENTIAL_PROVIDER_ID,
    POSSESSOR_VOICE_TOKEN_PATTERN,
    "possessor voice",
    PossessorVoiceCredentialError,
  );
}

/**
 * Bridge-owned first-run bootstrap. The bridge owns the listener, so it owns the
 * mint; a possessor only ever resolves, which avoids a cross-process mint race
 * producing two different tokens.
 */
export async function ensurePossessorVoiceCredential(
  options: MintPossessorVoiceCredentialOptions = {},
): Promise<string> {
  return ensureStoredBearer(
    options,
    POSSESSOR_VOICE_CREDENTIAL_PROVIDER_ID,
    () => mintPossessorVoiceToken(options.randomBytes),
    resolvePossessorVoiceCredential,
    "possessor voice",
    PossessorVoiceCredentialError,
  );
}
