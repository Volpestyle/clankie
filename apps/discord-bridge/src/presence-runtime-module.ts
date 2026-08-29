import { createDefaultCredentialStore, DiscordBotCredentialProvider } from "@clankie/credential-broker";
import { parseDiscordIdSet, presenceActGrantRequest } from "@clankie/discord-presence-core";
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
 * Deny-by-default surface → embedded application id map (ADR 0047). A surface
 * with no configured application id cannot be launched at all, so activity
 * publication stays off until an owner deliberately turns it on.
 */
function activitySurfaces(): Partial<Record<DiscordActivitySurface, string>> {
  const emulator = process.env.DISCORD_ACTIVITY_APPLICATION_ID_GBA?.trim();
  return emulator ? { gba_emulator: emulator } : {};
}
