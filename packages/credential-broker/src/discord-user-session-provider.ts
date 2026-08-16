import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { CapabilityTokenIssuer } from "./capability-token.ts";
import type { CredentialStore } from "./credential-store.ts";
import { DISCORD_PRESENCE_CAPABILITIES, type DiscordPresenceCapability } from "./discord-bot-provider.ts";

export const DISCORD_USER_SESSION_PROVIDER_ID = "discord_user_session";

export const DiscordUserSessionGrantRequestSchema = z
  .object({
    principalId: z.string().min(1),
    missionId: z.string().min(1),
    profileHash: z.string().min(1),
    capability: z.enum(DISCORD_PRESENCE_CAPABILITIES),
    guildIds: z.array(z.string().min(1)).default([]),
    channelIds: z.array(z.string().min(1)).default([]),
    ttlSeconds: z
      .number()
      .int()
      .positive()
      .max(15 * 60)
      .default(60),
  })
  .strict();
export type DiscordUserSessionGrantRequest = z.input<typeof DiscordUserSessionGrantRequestSchema>;

/**
 * Evidence that the owner accepted user-session risk under a specific
 * profile hash, supplied by the caller from the durable service record. The
 * provider never reads it from configuration, so flipping an environment
 * variable can never reach a user token.
 */
export interface DiscordUserSessionOptInProof {
  readonly optInId: string;
  readonly profileHash: string;
  readonly revoked: boolean;
}

export interface DiscordUserSessionCredentialProviderOptions {
  store: CredentialStore;
  allowedGuildIds: readonly string[];
  allowedChannelIds: readonly string[];
  /** Resolves the durable opt-in for the doctrine in force; `undefined` means none exists. */
  resolveOptIn: (profileHash: string) => Promise<DiscordUserSessionOptInProof | undefined>;
  issuer?: CapabilityTokenIssuer;
  now?: () => number;
}

export type DiscordUserSessionDenialCode =
  | "discord_user_session_opt_in_required"
  | "discord_user_session_opt_in_revoked"
  | "discord_user_session_opt_in_profile_mismatch"
  | "discord_user_session_guild_not_allowed"
  | "discord_user_session_channel_not_allowed"
  | "discord_user_session_resource_required"
  | "discord_user_session_grant_scope_denied"
  | "discord_user_session_credential_missing";

export class DiscordUserSessionDenied extends Error {
  public readonly code: DiscordUserSessionDenialCode;

  public constructor(code: DiscordUserSessionDenialCode, message: string) {
    super(message);
    this.name = "DiscordUserSessionDenied";
    this.code = code;
  }
}

/**
 * Trusted boundary for the normal-user Discord credential (ADR 0048).
 *
 * Mirrors {@link import("./discord-bot-provider.ts").DiscordBotCredentialProvider}
 * so both planes are governed the same way, and adds one gate the bot plane does
 * not need: a durable owner opt-in bound to the doctrine profile hash. Discord
 * forbids automating normal accounts, so possession of the token is deliberately
 * not sufficient to use it.
 */
export class DiscordUserSessionCredentialProvider {
  private readonly store: CredentialStore;
  private readonly allowedGuildIds: ReadonlySet<string>;
  private readonly allowedChannelIds: ReadonlySet<string>;
  private readonly resolveOptIn: DiscordUserSessionCredentialProviderOptions["resolveOptIn"];
  private readonly issuer: CapabilityTokenIssuer;
  private readonly now: () => number;

  public constructor(options: DiscordUserSessionCredentialProviderOptions) {
    this.store = options.store;
    this.allowedGuildIds = new Set(options.allowedGuildIds);
    this.allowedChannelIds = new Set(options.allowedChannelIds);
    this.resolveOptIn = options.resolveOptIn;
    this.issuer = options.issuer ?? new CapabilityTokenIssuer(randomBytes(32));
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  public async issueGrant(input: DiscordUserSessionGrantRequest): Promise<string> {
    const request = DiscordUserSessionGrantRequestSchema.parse(input);
    this.assertAllowed(request.guildIds, request.channelIds);
    await this.assertOptedIn(request.profileHash);
    await this.requireUserToken();
    const issuedAt = this.now();
    return this.issuer.issue({
      version: 1,
      grantId: randomUUID(),
      principalId: request.principalId,
      missionId: request.missionId,
      profileHash: request.profileHash,
      capabilities: [request.capability],
      resources: resources(request.guildIds, request.channelIds),
      obligations: [],
      issuedAt,
      expiresAt: issuedAt + request.ttlSeconds,
      nonce: randomBytes(16).toString("hex"),
    });
  }

  public async resolveUserToken(input: {
    grant: string;
    principalId: string;
    missionId: string;
    profileHash: string;
    capability: DiscordPresenceCapability;
    guildIds?: readonly string[];
    channelIds?: readonly string[];
  }): Promise<string> {
    const guildIds = [...(input.guildIds ?? [])];
    const channelIds = [...(input.channelIds ?? [])];
    this.assertAllowed(guildIds, channelIds);
    // Re-checked at redemption, not only at issue: a revocation between the two
    // must stop the very next action rather than waiting for grant expiry.
    await this.assertOptedIn(input.profileHash);
    const verified = this.issuer.verify(input.grant, this.now());
    if (
      verified.grant.principalId !== input.principalId ||
      verified.grant.missionId !== input.missionId ||
      verified.grant.profileHash !== input.profileHash ||
      !verified.grant.capabilities.includes(input.capability) ||
      resources(guildIds, channelIds).some((resource) => !verified.grant.resources.includes(resource))
    ) {
      throw new DiscordUserSessionDenied(
        "discord_user_session_grant_scope_denied",
        "The presented grant does not cover this user-session request",
      );
    }
    return this.requireUserToken();
  }

  private async assertOptedIn(profileHash: string): Promise<void> {
    const optIn = await this.resolveOptIn(profileHash);
    if (optIn === undefined) {
      throw new DiscordUserSessionDenied(
        "discord_user_session_opt_in_required",
        "No durable owner opt-in exists for the user-session transport",
      );
    }
    if (optIn.revoked) {
      throw new DiscordUserSessionDenied(
        "discord_user_session_opt_in_revoked",
        "The user-session opt-in was revoked",
      );
    }
    if (optIn.profileHash !== profileHash) {
      throw new DiscordUserSessionDenied(
        "discord_user_session_opt_in_profile_mismatch",
        "The user-session opt-in was recorded under a different doctrine profile",
      );
    }
  }

  private assertAllowed(guildIds: readonly string[], channelIds: readonly string[]): void {
    if (guildIds.some((id) => !this.allowedGuildIds.has(id))) {
      throw new DiscordUserSessionDenied(
        "discord_user_session_guild_not_allowed",
        "Guild is outside the user-session allowlist",
      );
    }
    if (channelIds.some((id) => !this.allowedChannelIds.has(id))) {
      throw new DiscordUserSessionDenied(
        "discord_user_session_channel_not_allowed",
        "Channel is outside the user-session allowlist",
      );
    }
    if (guildIds.length === 0 && channelIds.length === 0) {
      throw new DiscordUserSessionDenied(
        "discord_user_session_resource_required",
        "User-session grants must name at least one guild or channel",
      );
    }
  }

  private async requireUserToken(): Promise<string> {
    const credential = await this.store.get(DISCORD_USER_SESSION_PROVIDER_ID);
    if (credential?.type !== "api" || credential.key.trim().length === 0) {
      throw new DiscordUserSessionDenied(
        "discord_user_session_credential_missing",
        `No API credential stored for ${DISCORD_USER_SESSION_PROVIDER_ID}`,
      );
    }
    return credential.key;
  }
}

function resources(guildIds: readonly string[], channelIds: readonly string[]): string[] {
  return [
    ...new Set(guildIds.map((id) => `discord:guild:${id}`)),
    ...new Set(channelIds.map((id) => `discord:channel:${id}`)),
  ];
}
