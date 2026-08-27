import type { DiscordSettings } from "@clankie/settings";

/**
 * The complete authority/session decision for one authenticated Discord turn.
 * Literal fields make the unsafe state (durable shared session carrying a
 * per-user grant) unrepresentable.
 */
export type DiscordTurnSessionPlan =
  | {
      readonly kind: "social";
      readonly durable: boolean;
      readonly systemTools: false;
      readonly sessionKey: string;
    }
  | {
      readonly kind: "system_turn";
      readonly durable: false;
      readonly systemTools: true;
      readonly sessionKey: string;
    }
  | {
      readonly kind: "system_lane";
      readonly durable: true;
      readonly systemTools: true;
      readonly sessionKey: string;
      readonly grant: "dm_user" | "guild";
    };

type DiscordMachineSettings = Pick<
  DiscordSettings,
  "systemActorUserIds" | "systemActorGuildIds" | "systemActorChannelIds"
>;

/**
 * Bind machine tools either to one authenticated actor's turn or to a lane
 * whose entire admitted population has the same grant.
 *
 * Official bots cannot participate in group DMs, so an allowlisted user's bot
 * DM is private enough to own a durable tool bank. The lab user transport can
 * observe group DMs and therefore stays one-shot. A trusted guild grant is
 * intentionally broader: every admitted human in its selected channels gets
 * the tools, so the channel itself may safely own the durable session.
 */
export function planDiscordTurnSession(input: {
  readonly baseSessionKey: string;
  readonly durable: boolean;
  readonly actorId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly transportKind: "bot" | "user_session";
  readonly settings: DiscordMachineSettings;
}): DiscordTurnSessionPlan {
  const userGranted = input.settings.systemActorUserIds.includes(input.actorId);
  const guildGranted =
    input.guildId !== undefined &&
    input.settings.systemActorGuildIds.includes(input.guildId) &&
    (input.settings.systemActorChannelIds.length === 0 ||
      input.settings.systemActorChannelIds.includes(input.channelId));
  const privateDmGranted = input.guildId === undefined && input.transportKind === "bot" && userGranted;
  const systemTools = userGranted || guildGranted;

  if (!systemTools) {
    return {
      kind: "social",
      durable: input.durable,
      systemTools: false,
      sessionKey: input.baseSessionKey,
    };
  }
  if (input.durable && (privateDmGranted || guildGranted)) {
    return {
      kind: "system_lane",
      durable: true,
      systemTools: true,
      sessionKey: `${input.baseSessionKey}:authority:system`,
      grant: privateDmGranted ? "dm_user" : "guild",
    };
  }
  return {
    kind: "system_turn",
    durable: false,
    systemTools: true,
    sessionKey: input.baseSessionKey,
  };
}
