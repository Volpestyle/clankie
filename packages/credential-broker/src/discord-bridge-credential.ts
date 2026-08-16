import { randomBytes } from "node:crypto";
import type { CredentialStore } from "./credential-store.ts";
import { ensureStoredBearer, mintStoredBearer, resolveStoredBearer } from "./stored-bearer.ts";

export const DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID = "clankie_discord_bridge";
export const DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID = "clankie_discord_voice_bridge";
export const DISCORD_USER_BRIDGE_CREDENTIAL_PROVIDER_ID = "clankie_discord_user_bridge";
export const DISCORD_USER_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID = "clankie_discord_user_voice_bridge";
const DISCORD_BRIDGE_TOKEN_PREFIX = "clankie_discord_";
const DISCORD_VOICE_BRIDGE_TOKEN_PREFIX = "clankie_discord_voice_";
const DISCORD_USER_BRIDGE_TOKEN_PREFIX = "clankie_discord_user_";
const DISCORD_USER_VOICE_BRIDGE_TOKEN_PREFIX = "clankie_discord_user_voice_";
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
  return mintStoredBearer(DISCORD_BRIDGE_TOKEN_PREFIX, "Discord bridge", random);
}

/** Mints the separate local bearer for Discord voice captain turns. */
export function mintDiscordVoiceBridgeToken(random: (size: number) => Buffer = randomBytes): string {
  return mintStoredBearer(DISCORD_VOICE_BRIDGE_TOKEN_PREFIX, "Discord bridge", random);
}

/** Mints the user-session plane's text bearer (ADR 0048). */
export function mintDiscordUserBridgeToken(random: (size: number) => Buffer = randomBytes): string {
  return mintStoredBearer(DISCORD_USER_BRIDGE_TOKEN_PREFIX, "Discord bridge", random);
}

/** Mints the user-session plane's voice bearer (ADR 0048). */
export function mintDiscordUserVoiceBridgeToken(random: (size: number) => Buffer = randomBytes): string {
  return mintStoredBearer(DISCORD_USER_VOICE_BRIDGE_TOKEN_PREFIX, "Discord bridge", random);
}

/** Reads the broker-owned bridge bearer without exposing it through environment configuration. */
export async function resolveDiscordBridgeCredential(
  options: DiscordBridgeCredentialOptions = {},
): Promise<string | undefined> {
  return resolveStoredBearer(
    options,
    DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID,
    DISCORD_BRIDGE_TOKEN_PATTERN,
    "Discord bridge",
    DiscordBridgeCredentialError,
  );
}

/**
 * Control-plane-owned first-run bootstrap. Other processes resolve this credential
 * only after the service has created it, which avoids cross-process mint races.
 */
export async function ensureDiscordBridgeCredential(
  options: MintDiscordBridgeCredentialOptions = {},
): Promise<string> {
  return ensureStoredBearer(
    options,
    DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID,
    () => mintDiscordBridgeToken(options.randomBytes),
    resolveDiscordBridgeCredential,
    "Discord bridge",
    DiscordBridgeCredentialError,
  );
}

/** Reads the voice-lane bearer without exposing it through environment configuration. */
export async function resolveDiscordVoiceBridgeCredential(
  options: DiscordBridgeCredentialOptions = {},
): Promise<string | undefined> {
  return resolveStoredBearer(
    options,
    DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
    DISCORD_VOICE_BRIDGE_TOKEN_PATTERN,
    "Discord voice bridge",
    DiscordBridgeCredentialError,
  );
}

/**
 * Control-plane-owned first-run bootstrap for the separately authenticated
 * Discord voice lane.
 */
export async function ensureDiscordVoiceBridgeCredential(
  options: MintDiscordBridgeCredentialOptions = {},
): Promise<string> {
  return ensureStoredBearer(
    options,
    DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
    () => mintDiscordVoiceBridgeToken(options.randomBytes),
    resolveDiscordVoiceBridgeCredential,
    "Discord voice bridge",
    DiscordBridgeCredentialError,
  );
}

/**
 * Reads the user-session plane's text bearer. Kept distinct from the bot
 * bearer so the service can bind `transportKind` to *authentication*
 * rather than trusting a self-declared field on the request body.
 */
export async function resolveDiscordUserBridgeCredential(
  options: DiscordBridgeCredentialOptions = {},
): Promise<string | undefined> {
  return resolveStoredBearer(
    options,
    DISCORD_USER_BRIDGE_CREDENTIAL_PROVIDER_ID,
    DISCORD_USER_BRIDGE_TOKEN_PATTERN,
    "Discord user-session bridge",
    DiscordBridgeCredentialError,
  );
}

/** Control-plane-owned first-run bootstrap for the user-session text lane. */
export async function ensureDiscordUserBridgeCredential(
  options: MintDiscordBridgeCredentialOptions = {},
): Promise<string> {
  return ensureStoredBearer(
    options,
    DISCORD_USER_BRIDGE_CREDENTIAL_PROVIDER_ID,
    () => mintDiscordUserBridgeToken(options.randomBytes),
    resolveDiscordUserBridgeCredential,
    "Discord user-session bridge",
    DiscordBridgeCredentialError,
  );
}

/** Reads the user-session plane's voice bearer. */
export async function resolveDiscordUserVoiceBridgeCredential(
  options: DiscordBridgeCredentialOptions = {},
): Promise<string | undefined> {
  return resolveStoredBearer(
    options,
    DISCORD_USER_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
    DISCORD_USER_VOICE_BRIDGE_TOKEN_PATTERN,
    "Discord user-session voice bridge",
    DiscordBridgeCredentialError,
  );
}

/** Control-plane-owned first-run bootstrap for the user-session voice lane. */
export async function ensureDiscordUserVoiceBridgeCredential(
  options: MintDiscordBridgeCredentialOptions = {},
): Promise<string> {
  return ensureStoredBearer(
    options,
    DISCORD_USER_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
    () => mintDiscordUserVoiceBridgeToken(options.randomBytes),
    resolveDiscordUserVoiceBridgeCredential,
    "Discord user-session voice bridge",
    DiscordBridgeCredentialError,
  );
}
