import type { CredentialStore } from "./credential-store.ts";
import { defineBrokeredBearer } from "./stored-bearer.ts";

/**
 * Local bearer for Clankie's play voice seam (ADR 0064).
 *
 * Play holds no Discord gateway, so it cannot speak or hear directly. It
 * presents this bearer to the active body's loopback play listener, and the
 * Discord body — which does hold the gateway and the live presence claim —
 * speaks and pushes what it already heard.
 *
 * Same rule as every other internal Clankie bearer: the token lives in the
 * broker store and is never read from environment configuration, so it does not
 * appear in shell history, `ps` output, or a `.env` file.
 */
export const PLAY_VOICE_CREDENTIAL_PROVIDER_ID = "clankie_play_voice";
const PLAY_VOICE_TOKEN_PREFIX = "clankie_play_voice_";
const PLAY_VOICE_TOKEN_PATTERN = /^clankie_play_voice_[A-Za-z0-9_-]{43}$/u;

/** Environment names that must never carry this token. */
export const PLAY_VOICE_FORBIDDEN_ENV = "CLANKIE_PLAY_VOICE_TOKEN" as const;

export type PlayVoiceCredentialErrorCode =
  | "invalid_stored_credential"
  | "missing"
  | "store_unavailable"
  | "environment_token_forbidden";

export class PlayVoiceCredentialError extends Error {
  public readonly code: PlayVoiceCredentialErrorCode;

  public constructor(code: PlayVoiceCredentialErrorCode, message: string) {
    super(message);
    this.name = "PlayVoiceCredentialError";
    this.code = code;
  }
}

export interface PlayVoiceCredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
}

const bearer = defineBrokeredBearer({
  providerId: PLAY_VOICE_CREDENTIAL_PROVIDER_ID,
  prefix: PLAY_VOICE_TOKEN_PREFIX,
  pattern: PLAY_VOICE_TOKEN_PATTERN,
  mintSubject: "play voice",
  resolveSubject: "play voice",
  ErrorClass: PlayVoiceCredentialError,
  forbiddenEnv: {
    name: PLAY_VOICE_FORBIDDEN_ENV,
    throwForbidden: (envName) =>
      new PlayVoiceCredentialError(
        "environment_token_forbidden",
        `${envName} must not be set; the play voice bearer lives in the credential broker`,
      ),
  },
});

/** Mints the local bearer shared by the active Discord body and Clankie's play client. */
export const mintPlayVoiceToken = bearer.mint;

/**
 * Refuse to start when the token is supplied through the environment. A process
 * that accepts both would silently prefer the weaker source.
 */
export const assertNoEnvironmentPlayVoiceToken = bearer.assertNoEnvironmentToken;

/** Reads the broker-owned play bearer. Returns undefined when unset. */
export const resolvePlayVoiceCredential = bearer.resolve;

/**
 * Active-body-owned first-run bootstrap. The Discord body owns the listener, so
 * it owns the mint; play only ever resolves, which avoids a cross-process mint
 * race producing two different tokens.
 */
export const ensurePlayVoiceCredential = bearer.ensure;
