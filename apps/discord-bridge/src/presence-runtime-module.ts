import { createDefaultCredentialStore, DiscordBotCredentialProvider } from "@clankie/credential-broker";
import type { DiscordPresenceWrite } from "@clankie/protocol";
import type { DiscordPresenceSessionRecord } from "@clankie/interactive-environment";
import type { REST } from "discord.js";
import { createFilesystemAttachmentResolver } from "./attachment-resolver.ts";
import { createDiscordBotPresenceRuntime } from "./bot-presence-runtime.ts";

/**
 * Trusted control-plane load target (CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE).
 * Loads the official bot token through the credential broker; never from env.
 */
export function createDiscordPresenceRuntime(options: { rest?: REST } = {}): {
  execute(
    write: DiscordPresenceWrite,
    session: DiscordPresenceSessionRecord,
  ): ReturnType<ReturnType<typeof createDiscordBotPresenceRuntime>["execute"]>;
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
    allowedGuildIds: commaSeparated(process.env.DISCORD_PRESENCE_GUILD_IDS),
    allowedChannelIds: commaSeparated(process.env.DISCORD_PRESENCE_CHANNEL_IDS),
  });
  return {
    async execute(write, session) {
      const guildIds = "guildId" in write.payload ? [write.payload.guildId] : [];
      const channelIds = "channelId" in write.payload ? [write.payload.channelId] : [];
      const principalId = write.identity.workerRunId ?? write.identity.characterId;
      // Capability grants predate ambient presence scopes and retain a missionId
      // field. Keep non-mission grants isolated under the stable presence session;
      // this value is never promoted to mission state or an approval record.
      const capabilityScopeId =
        write.identity.missionId ?? `discord-presence:${write.identity.presenceSessionId ?? "unknown"}`;
      const request = {
        principalId,
        missionId: capabilityScopeId,
        profileHash: write.identity.profileHash,
        capability: "discord.presence.act" as const,
        guildIds,
        channelIds,
      };
      const grant = await provider.issueGrant(request);
      const botToken = await provider.resolveBotToken({ grant, ...request });
      return createDiscordBotPresenceRuntime({
        botToken,
        ...(options.rest === undefined ? {} : { rest: options.rest }),
        resolveAttachment: createFilesystemAttachmentResolver(process.env.CLANKIE_DISCORD_ATTACHMENT_ROOT),
      }).execute(write, session);
    },
  };
}

function commaSeparated(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}
