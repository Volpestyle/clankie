import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { CapabilityTokenIssuer } from "./capability-token.ts";
import type { CredentialStore } from "./credential-store.ts";

export const DISCORD_BOT_PROVIDER_ID = "discord_bot";
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

  /**
   * An empty channel allowlist admits any channel inside an allowed guild,
   * matching what an empty ingress allowlist already means.
   *
   * The two lists previously read the same value in opposite directions: blank
   * ingress channels admitted every channel in the allowed guilds, blank
   * presence channels admitted none. Clankie could therefore be addressed in far
   * more places than he could answer — he heard the message, composed a reply,
   * and was refused at the last step with nothing surfaced in Discord. Silent,
   * and indistinguishable from him ignoring you.
   *
   * The guild allowlist stays the fence. Widening happens only *within* guilds
   * already approved, and a provider with no guilds configured still grants
   * nothing, so an unconfigured deployment remains closed rather than becoming
   * open by omission.
   */
  private assertAllowed(guildIds: readonly string[], channelIds: readonly string[]): void {
    if (guildIds.some((id) => !this.allowedGuildIds.has(id))) {
      throw new Error("discord_bot_guild_not_allowed");
    }
    if (this.allowedChannelIds.size === 0) {
      // Nothing narrows channels, so this provider admits any of them — but only
      // once it is configured at all. A provider with no guilds and no channels
      // is an unconfigured deployment and still grants nothing, rather than
      // becoming wide open by omission.
      //
      // The remaining fence for channel-scoped actions is upstream: the ingress
      // allowlists decide which channels Clankie can be addressed in, and this
      // is what makes his speech reach exactly as far as his hearing. It cannot
      // be the guild allowlist, because the actions that matter most here are
      // channel-scoped by construction — a `reply` payload carries a channelId
      // and a messageId and no guild at all, so requiring one denied every reply
      // ever sent.
      if (this.allowedGuildIds.size === 0) throw new Error("discord_bot_channel_not_allowed");
    } else if (channelIds.some((id) => !this.allowedChannelIds.has(id))) {
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
