import { createDefaultCredentialStore, DiscordBotCredentialProvider } from "@clankie/credential-broker";
import {
  parseDiscordIdSet,
  planDiscordChannelCreate,
  planDiscordGuildChannels,
  planDiscordWebhookCreate,
  presenceActGrantRequest,
  readDiscordGuildRooms,
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
  provisionChannel(input: {
    readonly name: string;
    readonly topic?: string;
    readonly channelId?: string;
  }): Promise<{
    readonly guildId: string;
    readonly channelId: string;
    readonly webhookId: string;
    readonly webhookToken: string;
  }>;
  listRooms(): Promise<readonly { readonly channelId: string; readonly name: string }[]>;
  swarmGuildId(): string | undefined;
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
  const store = createDefaultCredentialStore();
  const provider = new DiscordBotCredentialProvider({
    store,
    allowedGuildIds: [...parseDiscordIdSet(process.env.DISCORD_PRESENCE_GUILD_IDS)],
    allowedChannelIds: [...parseDiscordIdSet(process.env.DISCORD_PRESENCE_CHANNEL_IDS)],
  });
  /**
   * A REST client under one guild-scoped grant. Synthetic but stable identity:
   * `resolveBotToken` only checks that the grant it verifies matches the
   * request it is handed, and the real fence is the guild allowlist that
   * `assertAllowed` applies to both.
   *
   * Fenced to the swarm home alone, and independently of the presence
   * allowlist. Presence governs where Clankie talks; the swarm home governs
   * where his agents get rooms. Reading the grant off the presence list would
   * quietly make the two one field again — the swarm home would only work if
   * it were also a guild he was configured to talk in.
   */
  const guildRest = async (guildId: string): Promise<REST> => {
    const provisionProvider = new DiscordBotCredentialProvider({
      store,
      allowedGuildIds: [guildId],
      allowedChannelIds: [],
    });
    const scope = {
      principalId: "clankie-channels",
      missionId: "discord-channel-provision",
      profileHash: "unversioned",
      capability: "discord.presence.act" as const,
      guildIds: [guildId],
      channelIds: [],
    };
    const grant = await provisionProvider.issueGrant(scope);
    const botToken = await provisionProvider.resolveBotToken({ grant, ...scope });
    return options.rest ?? new DiscordREST({ version: "10" }).setToken(botToken);
  };
  return {
    /**
     * Which server is the swarm home, so a pasted webhook can be held to it.
     * Not a secret — a guild id names a place, it does not open one — but it is
     * answered here because this module is what decides the question.
     */
    swarmGuildId: () => process.env.DISCORD_SWARM_GUILD_ID?.trim() || undefined,
    /**
     * The swarm home's rooms, so the operator picks one instead of copying a
     * webhook URL out of Server Settings. Same guild-scoped grant as
     * provisioning, and the same fence: nothing here can name a room outside
     * the one server Clankie controls.
     */
    async listRooms() {
      const guildId = provisionGuildId();
      const rest = await guildRest(guildId);
      return readDiscordGuildRooms(await rest.get(planDiscordGuildChannels(guildId).path as `/${string}`));
    },
    /**
     * Behind one guild-scoped grant: make the channel when there is none to
     * use, then its webhook. The guild allowlist is the fence — nothing here
     * can reach a server the owner has not approved, and a `channelId` handed
     * in is checked against that guild's own rooms rather than trusted, so a
     * room in a merely-inhabited guild cannot be reached through the swarm one.
     */
    async provisionChannel(input) {
      const guildId = provisionGuildId();
      const rest = await guildRest(guildId);
      let channelId = input.channelId;
      if (channelId === undefined) {
        const channelPlan = planDiscordChannelCreate({
          guildId,
          name: input.name,
          ...(input.topic === undefined ? {} : { topic: input.topic }),
        });
        const channel = (await rest.post(channelPlan.path as `/${string}`, {
          body: channelPlan.body,
        })) as { id?: unknown };
        if (typeof channel.id !== "string") throw new Error("discord_channel_provision_failed");
        channelId = channel.id;
      } else {
        const rooms = readDiscordGuildRooms(
          await rest.get(planDiscordGuildChannels(guildId).path as `/${string}`),
        );
        if (!rooms.some((room) => room.channelId === channelId)) {
          throw new Error("discord_channel_not_in_swarm_guild");
        }
      }
      const webhookPlan = planDiscordWebhookCreate({ channelId, name: input.name });
      const webhook = (await rest.post(webhookPlan.path as `/${string}`, {
        body: webhookPlan.body,
      })) as { id?: unknown; token?: unknown };
      if (typeof webhook.id !== "string" || typeof webhook.token !== "string") {
        throw new Error("discord_webhook_provision_failed");
      }
      return {
        guildId,
        channelId,
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
 * The one guild Clankie makes rooms in: the swarm home (ADR 0146). Named
 * explicitly and never inferred. `DISCORD_GUILD_ID` is the command and
 * live-proof server and deliberately does not answer here, and neither does the
 * presence allowlist: a server Clankie merely inhabits belongs on every ingress,
 * presence, and voice list without ever becoming somewhere his agents can be
 * given a channel. Unset means no room is provisioned at all.
 */
function provisionGuildId(): string {
  const swarm = process.env.DISCORD_SWARM_GUILD_ID?.trim();
  if (!swarm) throw new Error("discord_swarm_guild_unset");
  return swarm;
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
