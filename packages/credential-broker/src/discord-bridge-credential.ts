import type { CredentialStore } from "./credential-store.ts";
import { defineBrokeredBearer } from "./stored-bearer.ts";

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

function discordBearer(input: {
  providerId: string;
  prefix: string;
  pattern: RegExp;
  resolveSubject: string;
}) {
  return defineBrokeredBearer({
    ...input,
    mintSubject: "Discord bridge",
    ErrorClass: DiscordBridgeCredentialError,
  });
}

const bot = discordBearer({
  providerId: DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID,
  prefix: DISCORD_BRIDGE_TOKEN_PREFIX,
  pattern: DISCORD_BRIDGE_TOKEN_PATTERN,
  resolveSubject: "Discord bridge",
});
const voice = discordBearer({
  providerId: DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
  prefix: DISCORD_VOICE_BRIDGE_TOKEN_PREFIX,
  pattern: DISCORD_VOICE_BRIDGE_TOKEN_PATTERN,
  resolveSubject: "Discord voice bridge",
});
const user = discordBearer({
  providerId: DISCORD_USER_BRIDGE_CREDENTIAL_PROVIDER_ID,
  prefix: DISCORD_USER_BRIDGE_TOKEN_PREFIX,
  pattern: DISCORD_USER_BRIDGE_TOKEN_PATTERN,
  resolveSubject: "Discord user-session bridge",
});
const userVoice = discordBearer({
  providerId: DISCORD_USER_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
  prefix: DISCORD_USER_VOICE_BRIDGE_TOKEN_PREFIX,
  pattern: DISCORD_USER_VOICE_BRIDGE_TOKEN_PATTERN,
  resolveSubject: "Discord user-session voice bridge",
});

/** Mints the local bearer used only between the Discord bridge and the service. */
export const mintDiscordBridgeToken = bot.mint;
export const resolveDiscordBridgeCredential = bot.resolve;
export const ensureDiscordBridgeCredential = bot.ensure;

/** Mints the separate local bearer for Discord voice captain turns. */
export const mintDiscordVoiceBridgeToken = voice.mint;
export const resolveDiscordVoiceBridgeCredential = voice.resolve;
export const ensureDiscordVoiceBridgeCredential = voice.ensure;

/** Mints the user-session plane's text bearer (ADR 0048). */
export const mintDiscordUserBridgeToken = user.mint;
export const resolveDiscordUserBridgeCredential = user.resolve;
export const ensureDiscordUserBridgeCredential = user.ensure;

/** Mints the user-session plane's voice bearer (ADR 0048). */
export const mintDiscordUserVoiceBridgeToken = userVoice.mint;
export const resolveDiscordUserVoiceBridgeCredential = userVoice.resolve;
export const ensureDiscordUserVoiceBridgeCredential = userVoice.ensure;
