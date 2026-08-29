import type { CredentialStore } from "@clankie/credential-broker";
import { DISCORD_USER_SESSION_PROVIDER_ID } from "@clankie/credential-broker";
import { parseDiscordIdSet } from "@clankie/discord-presence-core";
import type { DiscordUserSessionOptIn } from "@clankie/protocol";
import { isDiscordBodyActive } from "@clankie/settings";

/**
 * Every precondition for wearing the user-session body, in one place (ADR 0048).
 *
 * Ordered cheapest-first and fail-closed. The ordering matters for a specific
 * reason: the brokered token is resolved *last*, so a run that is going to be
 * refused never materialises a normal-user credential in process memory at all.
 */

export interface UserSessionAdmissionPort {
  getHealth(): Promise<{ readonly profileHash: string }>;
  inspectDiscordUserSessionOptIn(): Promise<DiscordUserSessionOptIn | undefined>;
}

export interface UserSessionAdmission {
  readonly optIn: DiscordUserSessionOptIn;
  readonly profileHash: string;
  readonly userToken: string;
}

export type UserSessionRefusalCode =
  | "discord_user_session_disabled"
  | "discord_user_session_inactive_body"
  | "discord_user_session_allowlist_required"
  | "discord_user_session_opt_in_required"
  | "discord_user_session_opt_in_revoked"
  | "discord_user_session_opt_in_profile_mismatch"
  | "discord_user_session_opt_in_character_mismatch"
  | "discord_user_session_opt_in_scope_mismatch"
  | "discord_user_session_credential_missing";

export class DiscordUserSessionRefused extends Error {
  public readonly code: UserSessionRefusalCode;

  public constructor(code: UserSessionRefusalCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "DiscordUserSessionRefused";
    this.code = code;
  }
}

export async function assertUserSessionAdmissible(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly store: CredentialStore;
  readonly api: UserSessionAdmissionPort;
  readonly characterId: string;
}): Promise<UserSessionAdmission> {
  if (input.env.DISCORD_USER_SESSION_ENABLED !== "true") {
    throw new DiscordUserSessionRefused(
      "discord_user_session_disabled",
      "Set DISCORD_USER_SESSION_ENABLED=true to run the personal-lab user-session plane",
    );
  }
  if (!isDiscordBodyActive("user_session", input.env)) {
    throw new DiscordUserSessionRefused(
      "discord_user_session_inactive_body",
      "Set DISCORD_ACTIVE_BODY=user_session before starting this body directly",
    );
  }

  const guildIds = parseDiscordIdSet(input.env.DISCORD_USER_SESSION_GUILD_IDS);
  const channelIds = parseDiscordIdSet(input.env.DISCORD_USER_SESSION_CHANNEL_IDS);
  if (guildIds.size === 0 || channelIds.size === 0) {
    throw new DiscordUserSessionRefused(
      "discord_user_session_allowlist_required",
      "DISCORD_USER_SESSION_GUILD_IDS and DISCORD_USER_SESSION_CHANNEL_IDS must both be non-empty",
    );
  }

  const { profileHash } = await input.api.getHealth();
  const optIn = await input.api.inspectDiscordUserSessionOptIn();
  if (optIn === undefined) {
    throw new DiscordUserSessionRefused(
      "discord_user_session_opt_in_required",
      "No owner opt-in is recorded; record one on the authenticated operator surface first",
    );
  }
  if (optIn.revokedAt !== undefined) {
    throw new DiscordUserSessionRefused(
      "discord_user_session_opt_in_revoked",
      `The opt-in was revoked at ${optIn.revokedAt}`,
    );
  }
  if (optIn.profileHash !== profileHash) {
    // Profile hash changed since the risk was accepted. Re-accepting is
    // deliberate: an opt-in must not survive a policy change it was never
    // weighed against.
    throw new DiscordUserSessionRefused(
      "discord_user_session_opt_in_profile_mismatch",
      "The opt-in was recorded under a different profile hash; record it again",
    );
  }
  if (optIn.characterId !== input.characterId) {
    throw new DiscordUserSessionRefused(
      "discord_user_session_opt_in_character_mismatch",
      `The opt-in covers character ${optIn.characterId}, not ${input.characterId}`,
    );
  }

  // The recorded scope is the ceiling; configuration may narrow it, never widen
  // it. Otherwise editing an env var would silently extend a recorded consent.
  const optInGuilds = new Set(optIn.guildIds);
  const optInChannels = new Set(optIn.channelIds);
  const voiceIds = parseDiscordIdSet(input.env.DISCORD_USER_SESSION_VOICE_CHANNEL_IDS);
  const widened = [
    ...[...guildIds].filter((id) => !optInGuilds.has(id)).map((id) => `guild:${id}`),
    ...[...channelIds].filter((id) => !optInChannels.has(id)).map((id) => `channel:${id}`),
    ...[...voiceIds].filter((id) => !optInChannels.has(id)).map((id) => `channel:${id}`),
  ];
  if (widened.length > 0) {
    throw new DiscordUserSessionRefused(
      "discord_user_session_opt_in_scope_mismatch",
      `Configured scope exceeds the recorded opt-in: ${widened.join(", ")}`,
    );
  }

  const credential = await input.store.get(DISCORD_USER_SESSION_PROVIDER_ID);
  if (credential?.type !== "api" || credential.key.trim().length === 0) {
    throw new DiscordUserSessionRefused(
      "discord_user_session_credential_missing",
      `Store a ${DISCORD_USER_SESSION_PROVIDER_ID} API credential in the broker`,
    );
  }

  return { optIn, profileHash, userToken: credential.key };
}
