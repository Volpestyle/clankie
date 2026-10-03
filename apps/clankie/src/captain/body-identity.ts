import type { BodyConversationIdentity } from "../body-lease-router.ts";
import type { DiscordWatchOrigin } from "./conversation-owner.ts";
import { planDiscordTurnSession } from "./system-authority.ts";

/** Capture a turn's source grant once; later turns cannot downgrade an ongoing stay's requirement. */
export function captureDiscordBodyIdentity(
  capture: { shell?: boolean | undefined; bodyIdentity?: BodyConversationIdentity | undefined },
  conversationId: string,
  inputOrigin: DiscordWatchOrigin,
  settings: () => Promise<Parameters<typeof planDiscordTurnSession>[0]["settings"]>,
): BodyConversationIdentity {
  const requiresShell = capture.shell === true;
  const origin = Object.freeze({ ...inputOrigin });
  const identity: BodyConversationIdentity = {
    conversationId,
    route: { owner: { conversationId, discord: origin }, mode: requiresShell ? "machine" : "social" },
    current: () => capture.bodyIdentity === identity,
    authorize: async () => {
      const currentPlan = planDiscordTurnSession({
        baseSessionKey: origin.baseSessionKey,
        durable: true,
        actorId: origin.actorId,
        ...(origin.guildId === undefined ? {} : { guildId: origin.guildId }),
        channelId: origin.channelId,
        transportKind: origin.transportKind,
        settings: await settings(),
      });
      return !requiresShell || currentPlan.systemTools;
    },
  };
  return identity;
}

/** A social request never inherits a machine lane just because the actor gained a grant later. */
export function planConversationWakeSession(
  input: Parameters<typeof planDiscordTurnSession>[0],
  mode: "machine" | "social",
): ReturnType<typeof planDiscordTurnSession> {
  return mode === "social"
    ? {
        kind: "social",
        durable: true,
        systemTools: false,
        sessionKey: `${input.baseSessionKey}:body-request-social`,
      }
    : planDiscordTurnSession(input);
}
