import type { DiscordPresenceLiveClaim, DiscordPresenceToolExposure } from "@clankie/interactive-environment";
import type {
  CaptainChannelTurnResult,
  DiscordPresenceChannelTurnRequest,
  DiscordPresenceWrite,
  DiscordPresenceWriteResult,
} from "@clankie/protocol";
import type { DiscordPresenceSession } from "./presence-session.ts";
import type { DiscordTextIngressPort } from "./text-ingress.ts";

export interface DiscordPresenceActionDeliveryPort {
  getHealth(): Promise<{ profileHash: string }>;
  submitDiscordCaptainChannelTurn(
    request: DiscordPresenceChannelTurnRequest,
  ): Promise<CaptainChannelTurnResult>;
  executeDiscordPresenceAction(
    write: DiscordPresenceWrite,
    liveClaim: DiscordPresenceLiveClaim,
  ): Promise<DiscordPresenceWriteResult>;
}

/** Typed local rejection raised before a revoked action can reach the control plane. */
export class DiscordPresenceActToolUnavailableError extends Error {
  public readonly exposure: DiscordPresenceToolExposure;

  public constructor(exposure: DiscordPresenceToolExposure) {
    super(`discord_presence_act unavailable during ${exposure.phase}`);
    this.name = "DiscordPresenceActToolUnavailableError";
    this.exposure = exposure;
  }
}

/**
 * Production advertiser consumed by Discord text turns. It retains the live
 * catalog and forwards its phase as an authenticated execution fence.
 */
export function createAdvertisedDiscordPresencePort(
  delegate: DiscordPresenceActionDeliveryPort,
  session: DiscordPresenceSession,
): DiscordTextIngressPort {
  const advertised = session.toolCatalog("discord_presence");
  return {
    getHealth: () => delegate.getHealth(),
    submitDiscordCaptainChannelTurn: (request) => delegate.submitDiscordCaptainChannelTurn(request),
    executeDiscordPresenceAction: async (write) => {
      const exposure = advertised.current;
      if (!exposure.presenceTools.includes("discord_presence_act")) {
        throw new DiscordPresenceActToolUnavailableError(exposure);
      }
      const live = session.liveRecord;
      if (live.phase !== exposure.phase) {
        throw new DiscordPresenceActToolUnavailableError(session.toolCatalog("discord_presence").current);
      }
      return await delegate.executeDiscordPresenceAction(write, {
        schemaVersion: 1,
        sessionId: live.sessionId,
        phase: live.phase,
        revision: live.revision,
      });
    },
  };
}
