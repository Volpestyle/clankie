import type { DiscordPresenceWrite } from "@clankie/protocol";

/**
 * Capability grant request both Discord bodies issue before resolving a token.
 * The `missionId` slot is the frozen grant partition; presence grants mint a
 * namespaced stream id into it when the write carries no explicit one.
 */
export function presenceActGrantRequest(write: DiscordPresenceWrite): {
  principalId: string;
  missionId: string;
  profileHash: string;
  capability: "discord.presence.act";
  guildIds: string[];
  channelIds: string[];
} {
  const guildIds = "guildId" in write.payload ? [write.payload.guildId] : [];
  const channelIds = "channelId" in write.payload ? [write.payload.channelId] : [];
  return {
    principalId: write.identity.workerRunId ?? write.identity.characterId,
    missionId:
      write.identity.missionId ?? `discord-presence:${write.identity.presenceSessionId ?? "unknown"}`,
    profileHash: write.identity.profileHash,
    capability: "discord.presence.act",
    guildIds,
    channelIds,
  };
}
