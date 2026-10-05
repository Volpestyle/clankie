import {
  DISCORD_DIRECTORY_PATH,
  DiscordDirectoryRequestSchema,
  DiscordDirectorySnapshotSchema,
  DISCORD_SETTINGS_PATH,
  DiscordSettingsSnapshotSchema,
  DiscordSettingsUpdateSchema,
  parseProtocolResponse,
} from "@clankie/protocol";

/** Node-free Discord client; the transport owns authentication, encryption and HTTP errors. */
export function createDiscordSetupApi(options: {
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
}) {
  return {
    async discordSettings() {
      return parseProtocolResponse(
        DiscordSettingsSnapshotSchema,
        await options.request("GET", DISCORD_SETTINGS_PATH),
      );
    },
    async discordDirectory(input: unknown = {}) {
      const query = DiscordDirectoryRequestSchema.parse(input);
      const params = new URLSearchParams({ kind: query.kind, limit: String(query.limit) });
      if (query.guildId) params.set("guildId", query.guildId);
      if (query.after) params.set("after", query.after);
      return parseProtocolResponse(
        DiscordDirectorySnapshotSchema,
        await options.request("GET", `${DISCORD_DIRECTORY_PATH}?${params}`),
      );
    },
    async updateDiscordSettings(input: unknown) {
      return parseProtocolResponse(
        DiscordSettingsSnapshotSchema,
        await options.request("POST", DISCORD_SETTINGS_PATH, DiscordSettingsUpdateSchema.parse(input)),
      );
    },
  };
}
