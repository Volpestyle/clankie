import { createDiscordBotPresenceRuntime } from "./bot-presence-runtime.ts";

/**
 * Trusted control-plane load target (CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE).
 * Holds the official bot token only; never a Discord user token.
 */
export function createDiscordPresenceRuntime(): ReturnType<typeof createDiscordBotPresenceRuntime> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      "DISCORD_BOT_TOKEN is required for the Discord bot presence runtime. User tokens are unsupported.",
    );
  }
  if (process.env.DISCORD_USER_TOKEN) {
    throw new Error(
      "DISCORD_USER_TOKEN must not be set for the P1 bot presence runtime. User-session transport is P2.",
    );
  }
  return createDiscordBotPresenceRuntime({ botToken });
}
