import type { DiscordPresenceWrite } from "@clankie/protocol";

/**
 * Capability grant request both Discord bodies issue before resolving a token.
 * The missionId slot is a leftover wire field; presence grants stay isolated
 * under the presence session id when no mission is supplied.
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
