import {
  DiscordServerActionSchema,
  type DiscordServerAction,
  type DiscordServerActionResult,
  type DiscordSettings,
  DiscordServerPolicySchema,
} from "@clankie/protocol";

export interface DiscordServerAuthority {
  servers?: DiscordSettings["servers"] | undefined;
  ownerUserId?: string | undefined;
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
  "webhook_channel_id",
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
  const explicitGuild = /^\/guilds\/(\d{5,32})(?:\/|$)/u.exec(parsed.data.path)?.[1];
  let policy = authority.servers?.find(
    (entry) => entry.serverId === (explicitGuild ?? origin?.sourceGuildId),
  );
  let serverId = policy?.serverId ?? authority.serverId ?? authority.servers?.[0]?.serverId;
  if (
    parsed.data.method === "GET" &&
    origin?.source === "operator" &&
    /^\/channels\/\d{5,32}$/u.test(parsed.data.path) &&
    authority.servers?.length
  ) {
    try {
      const channel = record(await request(parsed.data));
      if (
        typeof channel?.guild_id !== "string" ||
        !authority.servers.some((entry) => entry.serverId === channel.guild_id)
      )
        return refuse("That channel is outside my connected Discord servers.");
      return {
        ok: true,
        message: "The Discord channel was read.",
        data: redact(channel) as DiscordServerActionResult["data"],
      };
    } catch {
      return refuse("Discord channel evidence unavailable.");
    }
  }
  // An operator may manage any configured server. Channel/webhook IDs carry no
  // guild claim, so resolve their native membership before selecting its role.
  if (origin?.source === "operator" && /^\/(?:channels|webhooks)\/\d{5,32}(?:\/|$)/u.test(parsed.data.path)) {
    try {
      const parts = parsed.data.path.split("/");
      const evidence = record(await request({ method: "GET", path: `/${parts[1]}/${parts[2]}` }));
      policy = authority.servers?.find((entry) => entry.serverId === evidence?.guild_id);
      if (!policy) return refuse("That resource is outside my connected Discord servers.");
      serverId = policy.serverId;
    } catch {
      return refuse("Discord server evidence unavailable.");
    }
  }
  const role = policy?.role ?? authority.role;
  if (parsed.data.path === "/users/@me") {
    if (parsed.data.method !== "GET" || origin?.source !== "operator" || !serverId)
      return refuse("Discord body identity is a host-only read.");
    try {
      return {
        ok: true,
        message: "The Discord body identity was read.",
        data: redact(await request(parsed.data)) as DiscordServerActionResult["data"],
      };
    } catch {
      return refuse("Discord body identity unavailable.");
    }
  }
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
  if (
    role !== "admin" &&
    !participantPost &&
    !(
      action.method === "GET" &&
      origin?.source === "operator" &&
      policy &&
      /^\/guilds\/\d{5,32}(?:\/roles|\/members\/\d{5,32})?$/u.test(action.path)
    )
  )
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
    if (action.method === "POST" && (parts[2] === "messages" || parts[2] === "threads")) {
      if (!(await discordOwnerAudience(authority, serverId, parts[1]!, request)))
        return refuse("discord_owner_audience_required");
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
    servers: env.DISCORD_SERVERS
      ? JSON.parse(env.DISCORD_SERVERS).map((entry: unknown) => DiscordServerPolicySchema.parse(entry))
      : [],
    ownerUserId: env.DISCORD_OWNER_USER_ID,
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

/** Conservative proof of every possible reader; unknown permissions fail closed. */
export async function discordOwnerAudience(
  authority: Pick<DiscordServerAuthority, "servers" | "ownerUserId">,
  guildId: string,
  channelId: string,
  request: DiscordServerRequest,
): Promise<boolean> {
  const policy = authority.servers?.find((entry) => entry.serverId === guildId);
  if (!policy) return false;
  try {
    let channel = record(await request({ method: "GET", path: `/channels/${channelId}` }));
    if (channel?.guild_id !== guildId) return false;
    // Threads inherit parent read access; a member list is not a reader proof.
    if ([10, 11, 12].includes(Number(channel.type))) {
      if (typeof channel.parent_id !== "string") return false;
      channel = record(await request({ method: "GET", path: `/channels/${channel.parent_id}` }));
      if (channel?.guild_id !== guildId) return false;
    }
    if (policy.owners === "everyone") return true;
    const overwrites = channel.permission_overwrites;
    if (!Array.isArray(overwrites)) return false;
    const everyone = overwrites.map(record).find((entry) => entry?.id === guildId && entry.type === 0);
    if (typeof everyone?.deny !== "string" || (BigInt(everyone.deny) & 1024n) === 0n) return false;
    const guild = record(await request({ method: "GET", path: `/guilds/${guildId}` }));
    if (typeof guild?.owner_id !== "string") return false;
    if (!(await discordActorOwnsServer(authority, guildId, guild.owner_id, request))) return false;
    const self = record(await request({ method: "GET", path: "/users/@me" }));
    const selfId = self?.bot === true && typeof self.id === "string" ? self.id : undefined;
    const roles = await request({ method: "GET", path: `/guilds/${guildId}/roles` });
    if (!Array.isArray(roles)) return false;
    // Administrator bypasses overwrites. A non-owner admin role makes privacy unprovable.
    for (const input of roles) {
      const role = record(input);
      if (!role || typeof role.permissions !== "string" || typeof role.id !== "string") return false;
      if (
        (BigInt(role.permissions) & 8n) !== 0n &&
        !(policy.owners === "role" && role.id === policy.ownerRoleId) &&
        !(selfId !== undefined && record(role.tags)?.bot_id === selfId)
      )
        return false;
    }
    for (const input of overwrites) {
      const entry = record(input);
      if (!entry || typeof entry.allow !== "string" || typeof entry.id !== "string") return false;
      if ((BigInt(entry.allow) & 1024n) === 0n) continue;
      if (entry.type === 0 && policy.owners === "role" && entry.id === policy.ownerRoleId) continue;
      if (entry.type === 1 && selfId !== undefined && entry.id === selfId) continue;
      if (entry.type === 1 && (await discordActorOwnsServer(authority, guildId, entry.id, request))) continue;
      return false;
    }
    const fresh = record(await request({ method: "GET", path: `/channels/${channel.id}` }));
    if (
      fresh?.guild_id !== guildId ||
      JSON.stringify(fresh.permission_overwrites) !== JSON.stringify(channel.permission_overwrites)
    )
      return false;
    if (channel.id !== channelId) {
      const thread = record(await request({ method: "GET", path: `/channels/${channelId}` }));
      if (thread?.guild_id !== guildId || thread.parent_id !== channel.id) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Only host-owned REST membership evidence may authorize a Discord role. */
export async function discordActorOwnsServer(
  authority: Pick<DiscordServerAuthority, "servers" | "ownerUserId">,
  guildId: string,
  actorId: string,
  request: DiscordServerRequest,
): Promise<boolean> {
  const policy = authority.servers?.find((entry) => entry.serverId === guildId);
  if (policy?.owners === "everyone") return true;
  if (!policy || policy.owners === "me") return actorId === authority.ownerUserId;
  try {
    const member = record(await request({ method: "GET", path: `/guilds/${guildId}/members/${actorId}` }));
    return (
      record(member?.user)?.id === actorId &&
      Array.isArray(member?.roles) &&
      member.roles.includes(policy.ownerRoleId)
    );
  } catch {
    return false;
  }
}
