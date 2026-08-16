import { randomBytes } from "node:crypto";
import { createDefaultCredentialStore, type CredentialStore } from "./credential-store.ts";

export const DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID = "clankie_discord_bridge";
export const DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID = "clankie_discord_voice_bridge";
export const DISCORD_USER_BRIDGE_CREDENTIAL_PROVIDER_ID = "clankie_discord_user_bridge";
export const DISCORD_USER_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID = "clankie_discord_user_voice_bridge";
const DISCORD_BRIDGE_TOKEN_PREFIX = "clankie_discord_";
const DISCORD_VOICE_BRIDGE_TOKEN_PREFIX = "clankie_discord_voice_";
const DISCORD_USER_BRIDGE_TOKEN_PREFIX = "clankie_discord_user_";
const DISCORD_USER_VOICE_BRIDGE_TOKEN_PREFIX = "clankie_discord_user_voice_";
const DISCORD_BRIDGE_TOKEN_BYTES = 32;
// Anchored and mutually exclusive: `clankie_discord_` is a prefix of every other
// bearer here, so the bot-plane pattern must reject the user-plane forms or a
// user-session bearer would authenticate as the bot bridge and inherit its lane.
const DISCORD_BRIDGE_TOKEN_PATTERN = /^clankie_discord_(?!voice_|user_)[A-Za-z0-9_-]{43}$/u;
const DISCORD_VOICE_BRIDGE_TOKEN_PATTERN = /^clankie_discord_voice_[A-Za-z0-9_-]{43}$/u;
const DISCORD_USER_BRIDGE_TOKEN_PATTERN = /^clankie_discord_user_(?!voice_)[A-Za-z0-9_-]{43}$/u;
const DISCORD_USER_VOICE_BRIDGE_TOKEN_PATTERN = /^clankie_discord_user_voice_[A-Za-z0-9_-]{43}$/u;

export type DiscordBridgeCredentialErrorCode = "invalid_stored_credential" | "missing" | "store_unavailable";

export class DiscordBridgeCredentialError extends Error {
  public readonly code: DiscordBridgeCredentialErrorCode;

  public constructor(code: DiscordBridgeCredentialErrorCode, message: string) {
    super(message);
    this.name = "DiscordBridgeCredentialError";
    this.code = code;
  }
}

export interface DiscordBridgeCredentialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
}

interface MintDiscordBridgeCredentialOptions extends DiscordBridgeCredentialOptions {
  readonly randomBytes?: (size: number) => Buffer;
}

/** Mints the local bearer used only between the Discord bridge and the service. */
export function mintDiscordBridgeToken(random: (size: number) => Buffer = randomBytes): string {
  return mintToken(DISCORD_BRIDGE_TOKEN_PREFIX, random);
}

/** Mints the separate local bearer for Discord voice captain turns. */
export function mintDiscordVoiceBridgeToken(random: (size: number) => Buffer = randomBytes): string {
  return mintToken(DISCORD_VOICE_BRIDGE_TOKEN_PREFIX, random);
}

/** Mints the user-session plane's text bearer (ADR 0048). */
export function mintDiscordUserBridgeToken(random: (size: number) => Buffer = randomBytes): string {
  return mintToken(DISCORD_USER_BRIDGE_TOKEN_PREFIX, random);
}

/** Mints the user-session plane's voice bearer (ADR 0048). */
export function mintDiscordUserVoiceBridgeToken(random: (size: number) => Buffer = randomBytes): string {
  return mintToken(DISCORD_USER_VOICE_BRIDGE_TOKEN_PREFIX, random);
}

function mintToken(prefix: string, random: (size: number) => Buffer): string {
  const entropy = random(DISCORD_BRIDGE_TOKEN_BYTES);
  if (entropy.length !== DISCORD_BRIDGE_TOKEN_BYTES) {
    throw new Error(
      `Discord bridge credential entropy source must return ${DISCORD_BRIDGE_TOKEN_BYTES} bytes`,
    );
  }
  return `${prefix}${entropy.toString("base64url")}`;
}

/** Reads the broker-owned bridge bearer without exposing it through environment configuration. */
export async function resolveDiscordBridgeCredential(
  options: DiscordBridgeCredentialOptions = {},
): Promise<string | undefined> {
  const store = options.store ?? defaultStore(options.env);
  const credential = await store.get(DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID);
  if (credential === undefined) return undefined;
  if (credential.type !== "api" || !DISCORD_BRIDGE_TOKEN_PATTERN.test(credential.key)) {
    throw new DiscordBridgeCredentialError(
      "invalid_stored_credential",
      "The stored Discord bridge credential is invalid; refusing to use it",
    );
  }
  return credential.key;
}

/**
 * Control-plane-owned first-run bootstrap. Other processes resolve this credential
 * only after the service has created it, which avoids cross-process mint races.
 */
export async function ensureDiscordBridgeCredential(
  options: MintDiscordBridgeCredentialOptions = {},
): Promise<string> {
  const existing = await resolveDiscordBridgeCredential(options);
  if (existing !== undefined) return existing;
  const store = options.store ?? defaultStore(options.env);
  try {
    await store.set(DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: mintDiscordBridgeToken(options.randomBytes),
    });
  } catch {
    throw new DiscordBridgeCredentialError(
      "store_unavailable",
      "Discord bridge credential bootstrap could not update the credential store",
    );
  }
  const persisted = await resolveDiscordBridgeCredential({ ...options, store });
  if (persisted === undefined) {
    throw new DiscordBridgeCredentialError(
      "missing",
      "Discord bridge credential bootstrap did not persist a token",
    );
  }
  return persisted;
}

/** Reads the voice-lane bearer without exposing it through environment configuration. */
export async function resolveDiscordVoiceBridgeCredential(
  options: DiscordBridgeCredentialOptions = {},
): Promise<string | undefined> {
  const store = options.store ?? defaultStore(options.env);
  const credential = await store.get(DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID);
  if (credential === undefined) return undefined;
  if (credential.type !== "api" || !DISCORD_VOICE_BRIDGE_TOKEN_PATTERN.test(credential.key)) {
    throw new DiscordBridgeCredentialError(
      "invalid_stored_credential",
      "The stored Discord voice bridge credential is invalid; refusing to use it",
    );
  }
  return credential.key;
}

/**
 * Control-plane-owned first-run bootstrap for the separately authenticated
 * Discord voice lane.
 */
export async function ensureDiscordVoiceBridgeCredential(
  options: MintDiscordBridgeCredentialOptions = {},
): Promise<string> {
  const existing = await resolveDiscordVoiceBridgeCredential(options);
  if (existing !== undefined) return existing;
  const store = options.store ?? defaultStore(options.env);
  try {
    await store.set(DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: mintDiscordVoiceBridgeToken(options.randomBytes),
    });
  } catch {
    throw new DiscordBridgeCredentialError(
      "store_unavailable",
      "Discord voice bridge credential bootstrap could not update the credential store",
    );
  }
  const persisted = await resolveDiscordVoiceBridgeCredential({ ...options, store });
  if (persisted === undefined) {
    throw new DiscordBridgeCredentialError(
      "missing",
      "Discord voice bridge credential bootstrap did not persist a token",
    );
  }
  return persisted;
}

/**
 * Reads the user-session plane's text bearer. Kept distinct from the bot
 * bearer so the service can bind `transportKind` to *authentication*
 * rather than trusting a self-declared field on the request body.
 */
export async function resolveDiscordUserBridgeCredential(
  options: DiscordBridgeCredentialOptions = {},
): Promise<string | undefined> {
  return resolveBearer(
    DISCORD_USER_BRIDGE_CREDENTIAL_PROVIDER_ID,
    DISCORD_USER_BRIDGE_TOKEN_PATTERN,
    "Discord user-session bridge",
    options,
  );
}

/** Control-plane-owned first-run bootstrap for the user-session text lane. */
export async function ensureDiscordUserBridgeCredential(
  options: MintDiscordBridgeCredentialOptions = {},
): Promise<string> {
  return ensureBearer(
    DISCORD_USER_BRIDGE_CREDENTIAL_PROVIDER_ID,
    () => mintDiscordUserBridgeToken(options.randomBytes),
    resolveDiscordUserBridgeCredential,
    "Discord user-session bridge",
    options,
  );
}

/** Reads the user-session plane's voice bearer. */
export async function resolveDiscordUserVoiceBridgeCredential(
  options: DiscordBridgeCredentialOptions = {},
): Promise<string | undefined> {
  return resolveBearer(
    DISCORD_USER_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
    DISCORD_USER_VOICE_BRIDGE_TOKEN_PATTERN,
    "Discord user-session voice bridge",
    options,
  );
}

/** Control-plane-owned first-run bootstrap for the user-session voice lane. */
export async function ensureDiscordUserVoiceBridgeCredential(
  options: MintDiscordBridgeCredentialOptions = {},
): Promise<string> {
  return ensureBearer(
    DISCORD_USER_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
    () => mintDiscordUserVoiceBridgeToken(options.randomBytes),
    resolveDiscordUserVoiceBridgeCredential,
    "Discord user-session voice bridge",
    options,
  );
}

async function resolveBearer(
  providerId: string,
  pattern: RegExp,
  label: string,
  options: DiscordBridgeCredentialOptions,
): Promise<string | undefined> {
  const store = options.store ?? defaultStore(options.env);
  const credential = await store.get(providerId);
  if (credential === undefined) return undefined;
  if (credential.type !== "api" || !pattern.test(credential.key)) {
    throw new DiscordBridgeCredentialError(
      "invalid_stored_credential",
      `The stored ${label} credential is invalid; refusing to use it`,
    );
  }
  return credential.key;
}

async function ensureBearer(
  providerId: string,
  mint: () => string,
  resolveExisting: (options: DiscordBridgeCredentialOptions) => Promise<string | undefined>,
  label: string,
  options: MintDiscordBridgeCredentialOptions,
): Promise<string> {
  const existing = await resolveExisting(options);
  if (existing !== undefined) return existing;
  const store = options.store ?? defaultStore(options.env);
  try {
    await store.set(providerId, { type: "api", key: mint() });
  } catch {
    throw new DiscordBridgeCredentialError(
      "store_unavailable",
      `${label} credential bootstrap could not update the credential store`,
    );
  }
  const persisted = await resolveExisting({ ...options, store });
  if (persisted === undefined) {
    throw new DiscordBridgeCredentialError(
      "missing",
      `${label} credential bootstrap did not persist a token`,
    );
  }
  return persisted;
}

function defaultStore(env: NodeJS.ProcessEnv | undefined): CredentialStore {
  return createDefaultCredentialStore(env === undefined ? {} : { env });
}
