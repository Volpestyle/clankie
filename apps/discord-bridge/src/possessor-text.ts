import { POSSESSOR_UTTERANCE_MAX_CHARS } from "@clankie/possessor-voice";

/** The allowlist text ingress already runs on, reused rather than restated. */
export interface PossessorRoomTextGate {
  readonly ingressGuildIds: ReadonlySet<string>;
  /** Empty admits every channel inside an allowlisted guild, as ingress does. */
  readonly ingressChannelIds: ReadonlySet<string>;
}

export interface PossessorRoomTextMessage {
  readonly guildId: string | null;
  readonly channelId: string;
  readonly authorIsBot: boolean;
  readonly body: string;
}

/**
 * The line a running playthrough should hear, or null when this message is not
 * the room talking to it.
 *
 * Text reaches a possessor on the seam voice already uses (ADR 0064), because
 * the two are the same act: someone in the channel he is playing in front of
 * saying something to him. Until this existed, voice was the only way in, so
 * steering a playthrough cost a `voice-consent opt-in` — and on 2026-08-15 a
 * FireRed session ran 82 turns with an empty interjection queue while the room
 * watched him search the wrong half of Viridian City.
 *
 * Admission is the ingress allowlist and nothing narrower. The voice side
 * pushes every line the room says rather than only the addressed ones, and a
 * stricter rule here would mean "clankie, go south" reached him while "go
 * south" did not — a distinction nobody watching would predict.
 *
 * What this can do is bounded by what an interjection is: something he hears
 * and may ignore. It is not a route and not an action, the free-play prompt
 * says so outright, and no tool or capability is reachable from here.
 */
export function possessorRoomText(
  gate: PossessorRoomTextGate,
  message: PossessorRoomTextMessage,
): string | null {
  if (message.authorIsBot) return null;
  // Guild channels only. A DM is a private conversation with him, not the room
  // he is playing in front of, and it carries no watching audience to steer.
  if (message.guildId === null) return null;
  if (!gate.ingressGuildIds.has(message.guildId)) return null;
  if (gate.ingressChannelIds.size > 0 && !gate.ingressChannelIds.has(message.channelId)) return null;
  const body = message.body.trim();
  if (body.length === 0) return null;
  // Truncated rather than dropped: the seam's schema is validated on the
  // possessor's side, so an over-long line would fail its parse and vanish
  // without anyone learning that the room went unheard.
  return body.slice(0, POSSESSOR_UTTERANCE_MAX_CHARS);
}
