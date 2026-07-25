import type { DiscordGatewayAdapterCreator, DiscordGatewayAdapterLibraryMethods } from "@discordjs/voice";
import type { GatewayVoiceStateUpdateDispatchData } from "discord-api-types/v10";
import type { DiscordUserGateway } from "./gateway.ts";

/**
 * Bridges our user-session gateway to `@discordjs/voice` (ADR 0045, ADR 0048).
 *
 * ADR 0045 fixed one media owner for Discord voice. That decision is about the
 * *media* stack, not about which credential opened the gateway: the voice
 * websocket authenticates with the VOICE_SERVER_UPDATE token, so the same
 * maintained implementation — including DAVE — works unchanged behind a user
 * session. Reusing it here avoids a second RTP/Opus/DAVE implementation whose
 * only difference would be how the gateway was authenticated.
 */
export class DiscordUserVoiceAdapters {
  private readonly gateway: DiscordUserGateway;
  private readonly adapters = new Map<string, DiscordGatewayAdapterLibraryMethods>();

  public constructor(gateway: DiscordUserGateway) {
    this.gateway = gateway;
    gateway.on("voiceServerUpdate", (server) => {
      this.adapters.get(server.guildId)?.onVoiceServerUpdate({
        token: server.token,
        guild_id: server.guildId,
        endpoint: server.endpoint,
      });
    });
    gateway.on("voiceStateUpdate", (state) => {
      // Only our own state drives the voice connection handshake; other members'
      // moves are consent/presence signals handled elsewhere.
      if (state.guildId === undefined || state.userId !== gateway.userId) return;
      this.adapters
        .get(state.guildId)
        ?.onVoiceStateUpdate(state.raw as unknown as GatewayVoiceStateUpdateDispatchData);
    });
  }

  /** Per-guild creator handed to `joinVoiceChannel`. */
  public creatorFor(guildId: string): DiscordGatewayAdapterCreator {
    return ((methods: DiscordGatewayAdapterLibraryMethods) => {
      this.adapters.set(guildId, methods);
      return {
        sendPayload: (payload: unknown) => this.gateway.sendPayload(payload),
        destroy: () => {
          this.adapters.delete(guildId);
        },
      };
    }) as unknown as DiscordGatewayAdapterCreator;
  }

  /** Called on shutdown so a destroyed gateway cannot leave adapters armed. */
  public destroyAll(): void {
    for (const methods of this.adapters.values()) methods.destroy();
    this.adapters.clear();
  }
}
