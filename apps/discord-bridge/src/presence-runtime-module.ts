import { createDefaultCredentialStore, DiscordBotCredentialProvider } from "@clankie/credential-broker";
import {
  parseDiscordIdSet,
  planDiscordChannelCreate,
  planDiscordWebhookCreate,
  presenceActGrantRequest,
} from "@clankie/discord-presence-core";
import { REST as DiscordREST } from "discord.js";
import type { DiscordActivitySurface, DiscordPresenceWrite } from "@clankie/protocol";
import type { DiscordPresenceSessionRecord } from "@clankie/interactive-environment";
import { discordAttachmentRoot } from "@clankie/settings";
import type { REST } from "discord.js";
import { createFilesystemAttachmentResolver } from "./attachment-resolver.ts";
import { DiscordBotPresenceRuntime } from "./bot-presence-runtime.ts";

/**
 * Trusted service load target (CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE).
 * Loads the official bot token through the credential broker; never from env.
 */
export function createDiscordPresenceRuntime(options: { rest?: REST } = {}): {
  execute(
    write: DiscordPresenceWrite,
    session: DiscordPresenceSessionRecord,
  ): ReturnType<DiscordBotPresenceRuntime["execute"]>;
  provisionChannel(input: { readonly name: string; readonly topic?: string }): Promise<{
    readonly guildId: string;
    readonly channelId: string;
    readonly webhookId: string;
    readonly webhookToken: string;
  }>;
} {
  if (process.env.DISCORD_USER_TOKEN) {
    throw new Error(
      "DISCORD_USER_TOKEN must not be set for the bot presence runtime. User-session transport uses the reserved discord_user_session provider.",
    );
  }
  if (process.env.DISCORD_BOT_TOKEN) {
    throw new Error(
      "DISCORD_BOT_TOKEN must not be set for the presence runtime. Store discord_bot in the credential broker.",
    );
  }
  const provider = new DiscordBotCredentialProvider({
    store: createDefaultCredentialStore(),
    allowedGuildIds: [...parseDiscordIdSet(process.env.DISCORD_PRESENCE_GUILD_IDS)],
    allowedChannelIds: [...parseDiscordIdSet(process.env.DISCORD_PRESENCE_CHANNEL_IDS)],
  });
  return {
    /**
     * Two calls behind one guild-scoped grant: make the channel, then its
     * webhook. The guild allowlist is the fence — nothing here can reach a
     * server the owner has not approved, and no channel id is required up
     * front because the channel is what this creates.
     */
    async provisionChannel(input) {
      const guildId = provisionGuildId();
      // Synthetic but stable identity: `resolveBotToken` only checks that the
      // grant it verifies matches the request it is handed, and the real fence
      // is the guild allowlist that `assertAllowed` applies to both.
      const scope = {
        principalId: "clankie-channels",
        missionId: "discord-channel-provision",
        profileHash: "unversioned",
        capability: "discord.presence.act" as const,
        guildIds: [guildId],
        channelIds: [],
      };
      const grant = await provider.issueGrant(scope);
      const botToken = await provider.resolveBotToken({ grant, ...scope });
      const rest = options.rest ?? new DiscordREST({ version: "10" }).setToken(botToken);
      const channelPlan = planDiscordChannelCreate({ guildId, name: input.name, ...(input.topic === undefined ? {} : { topic: input.topic }) });
      const channel = (await rest.post(channelPlan.path as `/${string}`, {
        body: channelPlan.body,
      })) as { id?: unknown };
      if (typeof channel.id !== "string") throw new Error("discord_channel_provision_failed");
      const webhookPlan = planDiscordWebhookCreate({ channelId: channel.id, name: input.name });
      const webhook = (await rest.post(webhookPlan.path as `/${string}`, {
        body: webhookPlan.body,
      })) as { id?: unknown; token?: unknown };
      if (typeof webhook.id !== "string" || typeof webhook.token !== "string") {
        throw new Error("discord_webhook_provision_failed");
      }
      return {
        guildId,
        channelId: channel.id,
        webhookId: webhook.id,
        webhookToken: webhook.token,
      };
    },
    async execute(write, session) {
      const request = presenceActGrantRequest(write);
      const grant = await provider.issueGrant(request);
      const botToken = await provider.resolveBotToken({ grant, ...request });
      return new DiscordBotPresenceRuntime({
        botToken,
        ...(options.rest === undefined ? {} : { rest: options.rest }),
        resolveAttachment: createFilesystemAttachmentResolver(discordAttachmentRoot(process.env)),
        activityApplicationIds: activitySurfaces(),
      }).execute(write, session);
    },
  };
}

/**
 * The one guild Clankie makes rooms in. An explicit home guild wins; otherwise
 * a single approved presence guild is unambiguous enough to use. More than one
 * and there is no right answer, so it asks rather than guessing which of the
 * owner's servers to put a room in.
 */
function provisionGuildId(): string {
  const home = process.env.DISCORD_GUILD_ID?.trim();
  if (home) return home;
  const approved = [...parseDiscordIdSet(process.env.DISCORD_PRESENCE_GUILD_IDS)];
  if (approved.length === 1) return approved[0]!;
  throw new Error(
    approved.length === 0
      ? "discord_provision_guild_unset"
      : "discord_provision_guild_ambiguous",
  );
}

/**
 * Deny-by-default surface → embedded application id map (ADR 0047). A surface
 * with no configured application id cannot be launched at all, so activity
 * publication stays off until an owner deliberately turns it on.
 */
function activitySurfaces(): Partial<Record<DiscordActivitySurface, string>> {
  const emulator = process.env.DISCORD_ACTIVITY_APPLICATION_ID_GBA?.trim();
  return emulator ? { gba_emulator: emulator } : {};
}
