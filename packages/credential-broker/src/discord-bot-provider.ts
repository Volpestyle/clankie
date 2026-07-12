import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { CapabilityTokenIssuer } from "./capability-token.ts";
import type { CredentialStore } from "./credential-store.ts";

export const DISCORD_BOT_PROVIDER_ID = "discord_bot";
export const DISCORD_USER_SESSION_PROVIDER_ID = "discord_user_session";
export const DISCORD_PRESENCE_CAPABILITIES = ["discord.presence.act", "discord.presence.read"] as const;
export type DiscordPresenceCapability = (typeof DISCORD_PRESENCE_CAPABILITIES)[number];

export const DiscordBotGrantRequestSchema = z
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
export type DiscordBotGrantRequest = z.input<typeof DiscordBotGrantRequestSchema>;

export interface DiscordBotCredentialProviderOptions {
  store: CredentialStore;
  allowedGuildIds: readonly string[];
  allowedChannelIds: readonly string[];
  issuer?: CapabilityTokenIssuer;
  now?: () => number;
}

/**
 * Trusted Discord bot credential boundary. Callers receive expiring grants;
 * only the trusted transport adapter may exchange a matching grant for the bot
 * token. Resource allowlists are fixed when the provider is constructed.
 */
export class DiscordBotCredentialProvider {
  private readonly store: CredentialStore;
  private readonly allowedGuildIds: ReadonlySet<string>;
  private readonly allowedChannelIds: ReadonlySet<string>;
  private readonly issuer: CapabilityTokenIssuer;
  private readonly now: () => number;

  public constructor(options: DiscordBotCredentialProviderOptions) {
    this.store = options.store;
    this.allowedGuildIds = new Set(options.allowedGuildIds);
    this.allowedChannelIds = new Set(options.allowedChannelIds);
    this.issuer = options.issuer ?? new CapabilityTokenIssuer(randomBytes(32));
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  public async issueGrant(input: DiscordBotGrantRequest): Promise<string> {
    const request = DiscordBotGrantRequestSchema.parse(input);
    this.assertAllowed(request.guildIds, request.channelIds);
    await this.requireBotToken();
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

  public async resolveBotToken(input: {
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
    const verified = this.issuer.verify(input.grant, this.now());
    if (
      verified.grant.principalId !== input.principalId ||
      verified.grant.missionId !== input.missionId ||
      verified.grant.profileHash !== input.profileHash ||
      !verified.grant.capabilities.includes(input.capability) ||
      resources(guildIds, channelIds).some((resource) => !verified.grant.resources.includes(resource))
    ) {
      throw new Error("discord_bot_grant_scope_denied");
    }
    return this.requireBotToken();
  }

  private assertAllowed(guildIds: readonly string[], channelIds: readonly string[]): void {
    if (guildIds.some((id) => !this.allowedGuildIds.has(id))) {
      throw new Error("discord_bot_guild_not_allowed");
    }
    if (channelIds.some((id) => !this.allowedChannelIds.has(id))) {
      throw new Error("discord_bot_channel_not_allowed");
    }
    if (guildIds.length === 0 && channelIds.length === 0) {
      throw new Error("discord_bot_resource_required");
    }
  }

  private async requireBotToken(): Promise<string> {
    const credential = await this.store.get(DISCORD_BOT_PROVIDER_ID);
    if (credential?.type !== "api" || credential.key.trim().length === 0) {
      throw new Error(`No API credential stored for ${DISCORD_BOT_PROVIDER_ID}`);
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
