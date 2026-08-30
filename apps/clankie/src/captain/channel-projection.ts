// Posting a channel's replies into the guild it is projected onto (ADR 0146).
//
// Writes ride a per-channel webhook, which is what lets every member appear as
// itself from one credential. It is not a bot application per seat — a
// registration, a token, and an invite for every agent is exactly the setup
// this feature exists to avoid — and it is certainly not a user account per
// seat, which ADR 0048 treats as an accepted ToS risk for one account and would
// be a fleet's worth of violations for a fleet.

import { planDiscordWebhookPost } from "@clankie/discord-presence-core";
import type { ChannelProjection } from "./conversations.ts";

const DISCORD_API = "https://discord.com/api/v10";
/** Discord's own limits. Exceeding either is a rejected post, not a truncated one. */
const CONTENT_MAX = 2_000;
const USERNAME_MAX = 80;

export function createChannelProjection(
  options: {
    readonly fetch?: typeof fetch;
    /** Trusted runtime that holds the bot token; absent leaves only pasted webhooks. */
    readonly provision?: ChannelProjection["provision"];
  } = {},
): ChannelProjection {
  const fetchImpl = options.fetch ?? fetch;
  return {
    post: post(fetchImpl),
    resolve: resolve(fetchImpl),
    ...(options.provision === undefined ? {} : { provision: options.provision }),
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

function post(fetchImpl: typeof fetch): ChannelProjection["post"] {
  return async (post) => {
    const plan = planDiscordWebhookPost({
      webhookId: post.webhookId,
      webhookToken: post.webhookToken,
      // A long answer is shown short rather than not shown: the transcript
      // holds all of it, and Discord is a view of the transcript.
      username: bounded(post.username, USERNAME_MAX),
      content: bounded(post.content, CONTENT_MAX),
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
