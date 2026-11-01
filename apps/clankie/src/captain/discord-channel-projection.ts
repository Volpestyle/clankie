// Posting a channel's replies into the guild it is projected onto (ADR 0146).
//
// Writes ride a per-channel webhook, which is what lets every member appear as
// itself from one credential. It is not a bot application per seat — a
// registration, a token, and an invite for every agent is exactly the setup
// this feature exists to avoid — and it is certainly not a user account per
// seat, which ADR 0048 treats as an accepted ToS risk for one account and would
// be a fleet's worth of violations for a fleet.

import {
  discordOwnerAudience,
  parseDiscordWebhookUrl,
  planDiscordWebhookPost,
} from "@clankie/discord-presence-core";
import { discordFleetGuild, discordGuildSettings, type DiscordSettings } from "@clankie/protocol";
import type { DiscordPresenceRuntimePort } from "../discord-presence-runtime.ts";
import type { ChannelProjection } from "./conversations.ts";
import type { CreateChannelProjection } from "./deps.ts";

const DISCORD_API = "https://discord.com/api/v10";
/** Discord's own limits. Exceeding either is a rejected post, not a truncated one. */
const CONTENT_MAX = 2_000;
const USERNAME_MAX = 80;

/**
 * The persona's channel projection, as the captain builds it (ADR 0328). The
 * trusted runtime that holds the bot token makes a room's webhook; without one,
 * only a pasted webhook projects.
 */
export function discordChannelProjection(
  runtime: Pick<DiscordPresenceRuntimePort, "provisionChannel" | "listRooms" | "swarmGuildId"> | undefined,
): CreateChannelProjection {
  return (host) =>
    createChannelProjection({
      fleetSettings: host.fleetSettings,
      ownerAudience: async (guildId, channelId) => {
        if (!host.discordActions) return false;
        const discord = await host.fleetSettings();
        return discordOwnerAudience(discord, guildId, channelId, async (action) => {
          const result = await host.discordActions!.serverAction(action);
          if (!result.ok) throw new Error("Discord audience unavailable");
          return result.data;
        });
      },
      ...(host.discordActions?.serverAction === undefined
        ? {}
        : {
            participantPost: async (channelId: string, content: string) => {
              const result = await host.discordActions!.serverAction({
                method: "POST",
                path: `/channels/${channelId}/messages`,
                body: { content, allowed_mentions: { parse: [] } },
              });
              if (!result.ok) throw new Error(result.message);
            },
          }),
      ...(runtime?.provisionChannel === undefined
        ? {}
        : { provision: (input) => runtime.provisionChannel!(input) }),
      ...(runtime?.listRooms === undefined ? {} : { rooms: () => runtime.listRooms!() }),
      ...(runtime?.swarmGuildId === undefined ? {} : { swarmGuildId: () => runtime.swarmGuildId!() }),
    });
}

export function createChannelProjection(
  options: {
    readonly fetch?: typeof fetch;
    /** Trusted runtime that holds the bot token; absent leaves the manual webhook. */
    readonly provision?: ChannelProjection["provision"];
    /** Same runtime, listing the managed server's rooms so one can be picked. */
    readonly rooms?: ChannelProjection["rooms"];
    /** Which guild the managed server is, so a pasted webhook can be held to it. */
    readonly swarmGuildId?: ChannelProjection["swarmGuildId"];
    /** Fresh owner settings gate existing credentials as well as provisioning. */
    readonly fleetSettings?: () => Promise<DiscordSettings>;
    readonly ownerAudience?: (guildId: string, channelId: string) => Promise<boolean>;
    readonly participantPost?: (channelId: string, content: string) => Promise<void>;
  } = {},
): ChannelProjection {
  const fetchImpl = options.fetch ?? fetch;
  let latestSettings: DiscordSettings | undefined;
  const fleetSettings = async () => {
    latestSettings = await options.fleetSettings!();
    return latestSettings;
  };
  const requireAdmin = async (guildId?: string, requireFleet = true) => {
    if (options.fleetSettings === undefined) return;
    const all = await fleetSettings();
    const target =
      guildId ??
      (requireFleet
        ? discordFleetGuild(all)
        : Object.keys(all.guilds).find((id) => all.guilds[id]?.role === "admin"));
    const settings = target ? discordGuildSettings(all, target) : all;
    if (
      settings.serverId === undefined ||
      settings.role !== "admin" ||
      (requireFleet && (!settings.fleetEnabled || settings.teamVisible === false)) ||
      (guildId !== undefined && settings.serverId !== guildId)
    )
      throw new Error("Discord fleet display requires Admin in the connected server and fleet enabled.");
  };
  return {
    parseWebhookUrl: parseDiscordWebhookUrl,
    post: async (input) => {
      await requireAdmin(input.guildId);
      if (options.fleetSettings !== undefined) {
        const target = await resolve(fetchImpl)(input);
        if (
          target.guildId !== input.guildId ||
          !(await options.ownerAudience?.(target.guildId, input.threadId ?? target.channelId))
        )
          throw new Error("discord_owner_audience_required");
        await requireAdmin(target.guildId);
      }
      await post(fetchImpl)(input);
    },
    resolve: async (input) => {
      await requireAdmin();
      const target = await resolve(fetchImpl)(input);
      await requireAdmin(target.guildId);
      return target;
    },
    remove: async (input) => {
      await requireAdmin(undefined, false);
      if (options.fleetSettings !== undefined) {
        const target = await resolve(fetchImpl)(input);
        await requireAdmin(target.guildId, false);
      }
      await remove(fetchImpl)(input);
    },
    ...(options.provision === undefined
      ? {}
      : {
          provision: async (input) => {
            await requireAdmin();
            return options.provision!(input);
          },
        }),
    ...(options.rooms === undefined
      ? {}
      : {
          rooms: async () => {
            await requireAdmin();
            return options.rooms!();
          },
        }),
    ...(options.fleetSettings === undefined
      ? {}
      : {
          allowsGuild: (guildId: string) =>
            latestSettings?.guilds[guildId]?.role === "admin" &&
            latestSettings.guilds[guildId]?.fleetEnabled === true,
        }),
    swarmGuildId: () =>
      latestSettings === undefined ? options.swarmGuildId?.() : discordFleetGuild(latestSettings),
    ...(options.fleetSettings === undefined
      ? {}
      : {
          currentGuildId: async () => {
            await requireAdmin();
            return latestSettings && discordFleetGuild(latestSettings);
          },
          autoProvision: async () => {
            const settings = await fleetSettings();
            return !!(options.provision && discordFleetGuild(settings));
          },
          participantPost: async (input) => {
            const settings = await fleetSettings();
            let participant = false;
            for (const policy of Object.values(settings.guilds)) {
              if (policy.role !== "participant") continue;
              participant = true;
              if (policy.fleetEnabled && policy.fleetChannelId && options.participantPost)
                await options.participantPost(
                  policy.fleetChannelId,
                  bounded(`**${input.username}**\n${input.content}`, CONTENT_MAX),
                );
            }
            return participant && !discordFleetGuild(settings);
          },
        }),
  };
}

/**
 * Ask Discord which room a webhook actually points at.
 *
 * The operator pastes one URL and nothing else: the guild and channel come back
 * with the webhook, so there are no ids to copy out of Discord by hand and no
 * way to bind a projection to the wrong room by mistyping one. This route
 * authenticates with the token in the URL, so it needs no bot grant — the same
 * reason the webhook is the credential in the first place.
 */
function resolve(fetchImpl: typeof fetch): ChannelProjection["resolve"] {
  return async (credential) => {
    const response = await fetchImpl(
      `${DISCORD_API}/webhooks/${credential.webhookId}/${credential.webhookToken}`,
    );
    if (!response.ok) throw new Error(`discord_webhook_unreachable_${response.status}`);
    const body = (await response.json()) as { guild_id?: unknown; channel_id?: unknown };
    if (typeof body.channel_id !== "string" || typeof body.guild_id !== "string") {
      // A webhook with no guild is not in a room a fleet can be put in.
      throw new Error("discord_webhook_not_in_a_guild");
    }
    return { guildId: body.guild_id, channelId: body.channel_id };
  };
}

/**
 * Delete a webhook Clankie made, when its room is unprojected or removed.
 * Token-authenticated like `resolve`, so no bot grant is needed. A webhook
 * already gone is the state being asked for, not a failure.
 */
function remove(fetchImpl: typeof fetch): NonNullable<ChannelProjection["remove"]> {
  return async (credential) => {
    const response = await fetchImpl(
      `${DISCORD_API}/webhooks/${credential.webhookId}/${credential.webhookToken}`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`discord_webhook_delete_failed_${response.status}`);
    }
  };
}

function post(fetchImpl: typeof fetch): ChannelProjection["post"] {
  return async (post) => {
    const plan = planDiscordWebhookPost({
      webhookId: post.webhookId,
      webhookToken: post.webhookToken,
      // A long answer is shown short rather than not shown: the transcript
      // holds all of it, and Discord is a view of the transcript.
      username: bounded(post.username, USERNAME_MAX),
      content: bounded(post.content, CONTENT_MAX),
      ...(post.avatarUrl === undefined ? {} : { avatarUrl: post.avatarUrl }),
      ...(post.threadId === undefined ? {} : { threadId: post.threadId }),
    });
    const response = await fetchImpl(`${DISCORD_API}${plan.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan.body),
    });
    if (!response.ok) throw new Error(`discord_webhook_post_failed_${response.status}`);
  };
}

function bounded(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
