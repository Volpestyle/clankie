import { MinecraftMcpPort as MinecraftConnector, type MinecraftEndpoint } from "@clankie/minecraft/connector";
import type { MinecraftServerProfile } from "@clankie/protocol";
import { MINECRAFT_BODY_ACCESS, type McpHost } from "./mcp-host.ts";
export type { MinecraftEndpoint };

/** Core alone projects its private MCP capability into the approved connector. */
export class MinecraftMcpPort extends MinecraftConnector {
  public constructor(options: {
    host: Pick<McpHost, "call">;
    profiles(): Promise<readonly MinecraftServerProfile[]>;
    resolveProfile(profileId: string): Promise<MinecraftEndpoint>;
  }) {
    super({
      profiles: options.profiles,
      resolveProfile: options.resolveProfile,
      call: async (input) => {
        const result = await options.host.call({
          lane: "operator",
          server: "minecraft",
          resultMode: "data",
          bodyAccess: MINECRAFT_BODY_ACCESS,
          ...input,
        });
        return result.outcome === "ok"
          ? { outcome: "ok", content: result.content, isError: result.isError === true }
          : { outcome: "refused", content: "", isError: true };
      },
    });
  }
}
