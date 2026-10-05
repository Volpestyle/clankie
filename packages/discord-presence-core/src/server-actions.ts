import {
  DiscordServerActionSchema,
  type DiscordServerAction,
  type DiscordServerActionResult,
} from "@clankie/protocol";

export interface DiscordServerAuthority {
  serverId?: string | undefined;
  role: "participant" | "admin";
  fleetEnabled: boolean;
  fleetChannelId?: string | undefined;
  trackingLevel: "off" | "project_updates" | "project_activity" | "all_issues";
}

/** The credential-owning transport implements this; it never exposes its token. */
export type DiscordServerRequest = (action: DiscordServerAction) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const CHANNEL_REFERENCES = new Set([
  "channel_id",
  "parent_id",
  "afk_channel_id",
  "system_channel_id",
  "rules_channel_id",
  "public_updates_channel_id",
  "safety_alerts_channel_id",
]);

function channelReferences(value: unknown, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) channelReferences(item, result);
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, item] of Object.entries(object)) {
    if (CHANNEL_REFERENCES.has(key) && typeof item === "string") result.add(item);
    channelReferences(item, result);
  }
}

/** Discord responses can contain webhook bearers; those never leave the body. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      /token|secret|authorization/iu.test(key) ||
      (typeof item === "string" && /\/webhooks\/\d+\/[\w-]+/u.test(item))
        ? "[redacted]"
        : redact(item),
    ]),
  );
}

/**
 * Role and server enforcement at the final REST boundary. Channel permissions
 * remain Discord's decision. No channel list grants authority and no local
 * machine capability is inferred from an admin server.
 */
export async function executeDiscordServerAction(
  input: DiscordServerAction,
  authority: DiscordServerAuthority,
  request: DiscordServerRequest,
  origin?: { source: "operator" | "discord"; sourceGuildId?: string | undefined },
): Promise<DiscordServerActionResult> {
  const parsed = DiscordServerActionSchema.safeParse(input);
  const refuse = (message: string): DiscordServerActionResult => ({ ok: false, message });
  if (!parsed.success) return refuse("That Discord server route is invalid.");
  const serverId = authority.serverId;
  if (!serverId || !/^\d{5,32}$/u.test(serverId)) return refuse("Connect a Discord server first.");
  if (origin?.source === "discord" && origin.sourceGuildId !== serverId)
    return refuse("That conversation is outside my connected Discord server.");
  const action = {
    ...parsed.data,
    path: parsed.data.path.replace(/^\/guilds\/@server(?=\/|$)/u, `/guilds/${serverId}`),
  };
  const parts = action.path.split("/").slice(1);
  const guildRoute = parts[0] === "guilds";
  const channelRoute = parts[0] === "channels";
  const webhookRoute = parts[0] === "webhooks";
  if (guildRoute && parts[1] !== serverId)
    return refuse("That server is outside my connected Discord server.");
  // The sole admin floor also covers the legacy user-session delete route.
  if (
    guildRoute &&
    ((parts.length === 2 && action.method === "DELETE") ||
      parts.slice(2).some((part) => ["delete", "ownership", "owner", "transfer"].includes(part)) ||
      (parts.length === 2 && Object.hasOwn(record(action.body) ?? {}, "owner_id")))
  )
    return refuse("I never delete a server or transfer its ownership.");
  const participantPost =
    channelRoute &&
    parts.length === 3 &&
    parts[2] === "messages" &&
    action.method === "POST" &&
    parts[1] === authority.fleetChannelId &&
    (authority.fleetEnabled || authority.trackingLevel !== "off");
  if (authority.role !== "admin" && !participantPost)
    return refuse(
      "Server management requires the admin role. Participant projections use the configured channel.",
    );

  try {
    const channels = new Set<string>();
    if (channelRoute) channels.add(parts[1]!);
    channelReferences(action.body, channels);
    // Reordering guild channels takes an array of { id, position, parent_id }.
    if (guildRoute && parts[2] === "channels" && Array.isArray(action.body))
      for (const item of action.body) {
        const channelId = record(item)?.id;
        if (typeof channelId === "string") channels.add(channelId);
      }
    for (const channelId of channels) {
      if (!/^\d{5,32}$/u.test(channelId)) return refuse("That channel reference is invalid.");
      const channel = record(await request({ method: "GET", path: `/channels/${channelId}` }));
      if (channel?.guild_id !== serverId)
        return refuse("That channel is outside my connected Discord server.");
    }
    if (webhookRoute) {
      const webhook = record(await request({ method: "GET", path: `/webhooks/${parts[1]!}` }));
      if (webhook?.guild_id !== serverId)
        return refuse("That webhook is outside my connected Discord server.");
    }
    let body = action.body;
    if (parts[2] === "messages" && record(body)) body = { ...record(body), allowed_mentions: { parse: [] } };
    if (parts[2] === "threads" && record(record(body)?.message))
      body = {
        ...record(body),
        message: { ...record(record(body)?.message), allowed_mentions: { parse: [] } },
      };
    const response = await request({ ...action, ...(body === undefined ? {} : { body }) });
    const resourceId = record(response)?.id;
    return {
      ok: true,
      message: "The Discord server action completed.",
      ...(typeof resourceId === "string" && /^\d{5,32}$/u.test(resourceId) ? { resourceId } : {}),
      ...(response === undefined ? {} : { data: redact(response) as DiscordServerActionResult["data"] }),
    };
  } catch {
    // Discord, rather than a local channel list, decides the member's grants.
    return refuse("Discord could not complete that action. Check the server setup grants and the target.");
  }
}

/** Effective startup environment, including settings materialized by the launcher. */
export function discordServerAuthority(env: NodeJS.ProcessEnv = process.env): DiscordServerAuthority {
  const tracking = env.DISCORD_TRACKING_LEVEL;
  return {
    serverId: env.DISCORD_SERVER_ID?.trim() || undefined,
    role: env.DISCORD_ROLE === "admin" ? "admin" : "participant",
    fleetEnabled: env.DISCORD_FLEET_ENABLED === "true",
    fleetChannelId: env.DISCORD_FLEET_CHANNEL_ID?.trim() || undefined,
    trackingLevel:
      tracking === "project_updates" || tracking === "project_activity" || tracking === "all_issues"
        ? tracking
        : "off",
  };
}
