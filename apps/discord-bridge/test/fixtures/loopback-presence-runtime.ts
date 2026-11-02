import { REST } from "discord.js";
import { DiscordBotPresenceRuntime } from "../../src/bot-presence-runtime.ts";

/**
 * A CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE for test services: the bridge's real
 * bot presence runtime, with discord.js REST pointed at a loopback Discord.
 * It skips the credential broker on purpose, so no bot token is read.
 */
export function createDiscordPresenceRuntime() {
  const api = process.env.CLANKIE_TEST_DISCORD_API;
  if (!api) throw new Error("CLANKIE_TEST_DISCORD_API must name the loopback Discord");
  const runtime = new DiscordBotPresenceRuntime({
    botToken: "fixture",
    rest: new REST({ version: "10", api }).setToken("fixture"),
  });
  return { execute: runtime.execute.bind(runtime), reconcileReply: runtime.reconcileReply.bind(runtime) };
}
