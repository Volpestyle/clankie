/**
 * Admission shared by every live consumer of a Discord room's text.
 *
 * The guild allowlist is the boundary; the optional channel list only narrows
 * it. A voice room and active play therefore hear exactly the guild text the
 * ordinary text ingress already admits, without acquiring a second policy.
 */
export interface DiscordRoomTextGate {
  readonly guildIds: ReadonlySet<string>;
  readonly channelIds: ReadonlySet<string>;
}

export interface DiscordRoomTextMessage {
  readonly guildId?: string;
  readonly channelId: string;
  readonly authorIsBot: boolean;
  readonly body: string;
}

/** One gateway-attributed message offered to the active voice room. */
export interface DiscordVoiceRoomTextInput {
  readonly guildId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly displayName?: string;
  readonly deliveryId: string;
  readonly text: string;
}

export interface DiscordRoomTextDelivery extends DiscordRoomTextMessage {
  readonly userId: string;
  readonly displayName?: string;
  readonly deliveryId: string;
  /** Voice does not receive Discord attachment bytes; text ingress does. */
  readonly hasAttachments: boolean;
}

export interface DiscordRoomTextVoiceSink {
  receiveRoomText(input: DiscordVoiceRoomTextInput): boolean;
}

export interface DiscordRoomTextRoute {
  /** The admitted line, also delivered once to live play. */
  readonly text: string | null;
  /** True means voice owns the response and ordinary text ingress must not run. */
  readonly voiceOwned: boolean;
}

/** Discord's ordinary message bound, also the play seam's utterance bound. */
export const DISCORD_ROOM_TEXT_MAX_CHARS = 2_000;

/** The admitted bounded line, or null when this is not a human guild-room message. */
export function admittedDiscordRoomText(
  gate: DiscordRoomTextGate,
  message: DiscordRoomTextMessage,
): string | null {
  if (message.authorIsBot || message.guildId === undefined) return null;
  if (!gate.guildIds.has(message.guildId)) return null;
  if (gate.channelIds.size > 0 && !gate.channelIds.has(message.channelId)) return null;
  const body = message.body.trim();
  return body.length === 0 ? null : body.slice(0, DISCORD_ROOM_TEXT_MAX_CHARS);
}

/** Shared bot/user-session routing for one Discord room message (ADR 0124). */
export function routeDiscordRoomText(
  gate: DiscordRoomTextGate,
  message: DiscordRoomTextDelivery,
  voice: DiscordRoomTextVoiceSink | undefined,
): DiscordRoomTextRoute {
  const text = admittedDiscordRoomText(gate, message);
  if (text === null || message.guildId === undefined || message.hasAttachments || voice === undefined) {
    return { text, voiceOwned: false };
  }
  return {
    text,
    voiceOwned: voice.receiveRoomText({
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.userId,
      ...(message.displayName === undefined ? {} : { displayName: message.displayName }),
      deliveryId: message.deliveryId,
      text,
    }),
  };
}
