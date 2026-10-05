import { DiscordPermissionCache } from "@clankie/discord-presence-core";
import type { Client } from "discord.js";

export function observeBotSetupPermissions(client: Client) {
  const cache = new DiscordPermissionCache();
  client.on("raw", (packet) => {
    if (typeof packet.t === "string" && packet.d && typeof packet.d === "object")
      cache.observe({ t: packet.t, d: packet.d as Record<string, unknown> });
  });
  return cache;
}
