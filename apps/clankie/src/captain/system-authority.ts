import type { DiscordSettings } from "@clankie/settings";

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
> &
  Partial<Pick<DiscordSettings, "servers" | "roomSkills" | "ownerUserId">>;

/** Role and channel evidence is supplied by the host, never the wire request. */
export function planDiscordTurnSession(input: {
  readonly baseSessionKey: string;
  readonly durable: boolean;
  readonly actorId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly transportKind: "bot" | "user_session";
  readonly settings: DiscordMachineSettings;
  readonly serverOwner?: boolean;
  readonly ownerAudience?: boolean;
}): DiscordTurnSessionPlan {
  const policy = input.settings.servers?.find((entry) => entry.serverId === input.guildId);
  const owner =
    input.guildId === undefined
      ? input.actorId === input.settings.ownerUserId
      : policy?.owners === "everyone" ||
        ((policy?.owners ?? "me") === "me" && input.actorId === input.settings.ownerUserId) ||
        (policy?.owners === "role" && input.serverOwner === true);
  const userGranted = input.settings.systemActorUserIds.includes(input.actorId);
  const systemTools = owner || userGranted;
  const privateDm = input.guildId === undefined && input.transportKind === "bot";
  const privateGuild = policy?.owners === "everyone" || input.ownerAudience === true;
  if (!systemTools)
    return { kind: "social", durable: input.durable, systemTools: false, sessionKey: input.baseSessionKey };
  if (input.durable && (privateDm || privateGuild))
    return {
      kind: "system_lane",
      durable: true,
      systemTools: true,
      sessionKey: `${input.baseSessionKey}:authority:system-v2:${JSON.stringify(policy ?? null)}`,
      grant: privateDm ? "dm_user" : "guild",
    };
  return { kind: "system_turn", durable: false, systemTools: true, sessionKey: input.baseSessionKey };
}
