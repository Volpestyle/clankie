import type { JoinDiscordVoiceInput } from "@clankie/discord-presence-core";
import type { DiscordVoicePresenceResult } from "@clankie/protocol";
import {
  authorizeVoicePresenceCommand,
  type DiscordCommandPrincipal,
  type DiscordRoleBindings,
  type DiscordVoiceJoinPolicy,
} from "./authority.ts";

type VoiceAdapterCreator = JoinDiscordVoiceInput["adapterCreator"];

export interface VoicePresenceSessionPort {
  status(): { readonly active: boolean; readonly guildId?: string; readonly channelId?: string };
  join(input: {
    readonly guildId: string;
    readonly channelId: string;
    readonly adapterCreator: VoiceAdapterCreator;
  }): Promise<unknown>;
  leave(): Promise<void>;
}

export interface VoicePresenceExecutionConfig {
  readonly bindings: DiscordRoleBindings;
  readonly joinPolicy: DiscordVoiceJoinPolicy;
  readonly voiceGuildIds: ReadonlySet<string>;
  readonly voiceChannelIds: ReadonlySet<string>;
  readonly voiceSession: VoicePresenceSessionPort | undefined;
}

export interface VoicePresenceExecutionInput {
  readonly intent: "join" | "leave";
  readonly guildId: string;
  readonly principal: DiscordCommandPrincipal;
  /** Fresh gateway state. The model never supplies a voice channel id. */
  readonly memberVoiceChannelId: string | undefined;
  readonly adapterCreator: VoiceAdapterCreator;
}

/** Authority and execution stay in the body that owns the gateway and media session. */
export async function executeVoicePresenceIntent(
  config: VoicePresenceExecutionConfig,
  input: VoicePresenceExecutionInput,
): Promise<DiscordVoicePresenceResult> {
  const refused = input.intent === "join" ? ("join_refused" as const) : ("leave_refused" as const);
  if (!authorizeVoicePresenceCommand(input.principal, config.bindings, config.joinPolicy).allowed) {
    return { action: refused, reason: "authority" };
  }
  const session = config.voiceSession;
  if (session === undefined) return { action: refused, reason: "voice_disabled" };
  if (input.intent === "leave") {
    const active = session.status();
    if (active.active && active.guildId !== input.guildId) {
      return { action: "leave_refused", reason: "other_guild" };
    }
    try {
      await session.leave();
    } catch {
      return { action: "leave_refused", reason: "failed" };
    }
    return { action: "left", ...(active.channelId === undefined ? {} : { channelId: active.channelId }) };
  }

  const channelId = input.memberVoiceChannelId;
  if (channelId === undefined) return { action: "join_refused", reason: "not_in_voice" };
  if (
    !config.voiceGuildIds.has(input.guildId) ||
    (config.voiceChannelIds.size > 0 && !config.voiceChannelIds.has(channelId))
  ) {
    return { action: "join_refused", reason: "allowlist" };
  }
  const active = session.status();
  if (active.active && active.guildId !== input.guildId) {
    return { action: "join_refused", reason: "other_guild" };
  }
  if (active.active && active.channelId === channelId) {
    return { action: "joined", channelId, actorAutoOptedIn: false };
  }
  try {
    await session.join({ guildId: input.guildId, channelId, adapterCreator: input.adapterCreator });
  } catch {
    return { action: "join_refused", reason: "failed" };
  }
  return { action: "joined", channelId, actorAutoOptedIn: false };
}
