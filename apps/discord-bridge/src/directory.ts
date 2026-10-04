import { discordChannelKind, discordDirectoryPage } from "@clankie/discord-presence-core";
import type {
  DiscordDirectoryRequest,
  DiscordDirectoryEntry,
  DiscordDirectorySnapshot,
} from "@clankie/protocol";
import { PermissionFlagsBits, ChannelType, type Client } from "discord.js";

/** Read the live account cache; no directory read fetches a new token or widens gateway intents. */
export function readBotDiscordDirectory(
  client: Client,
  query: DiscordDirectoryRequest,
  connected = client.isReady(),
): DiscordDirectorySnapshot {
  const page = (
    state: DiscordDirectorySnapshot["state"],
    entries: DiscordDirectoryEntry[] = [],
    reason?: DiscordDirectorySnapshot["reason"],
  ) =>
    discordDirectoryPage(query, { body: "bot", state, entries, ...(reason === undefined ? {} : { reason }) });
  if (!connected) return page("disconnected", [], "runtime_not_connected");
  if (query.kind === "servers") {
    const guilds = [...client.guilds.cache.values()];
    const partial = guilds.some((guild) => !guild.available);
    return page(
      partial ? "partial" : "connected",
      guilds
        .filter((guild) => guild.available)
        .map((guild) => ({ id: guild.id, name: guild.name, kind: "server" })),
      partial ? "gateway_cache_incomplete" : undefined,
    );
  }
  const guild = client.guilds.cache.get(query.guildId!);
  if (!guild?.available) return page("unavailable", [], "server_unavailable");
  if (query.kind === "roles")
    return page(
      "connected",
      [...guild.roles.cache.values()].map((role) => ({
        id: role.id,
        name: role.name,
        kind: "role",
        guildId: guild.id,
      })),
    );
  if (query.kind === "people")
    return page(
      "partial",
      [...guild.members.cache.values()].map((member) => ({
        id: member.id,
        name: member.displayName,
        kind: member.user.bot ? "bot" : "person",
        guildId: guild.id,
      })),
      "people_not_fully_loaded",
    );
  const me = guild.members.me;
  if (!me) return page("partial", [], "permissions_unknown");
  const entries = [...guild.channels.cache.values()]
    .filter((channel) => {
      const permissions = channel.permissionsFor(me);
      if (!permissions?.has(PermissionFlagsBits.ViewChannel)) return false;
      // ViewChannel on the parent alone does not admit a private thread.
      return (
        channel.type !== ChannelType.PrivateThread ||
        permissions.has(PermissionFlagsBits.ManageThreads) ||
        (channel.isThread() && channel.members.cache.has(me.id))
      );
    })
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      kind: discordChannelKind(channel.type),
      guildId: guild.id,
    }));
  // Gateway caches cover active threads, not every archived thread.
  return page("partial", entries, "gateway_cache_incomplete");
}
