import type { CaptainSessionLaneV2 } from "@clankie/protocol";

/**
 * Whether this Discord turn may use the operator's machine tools (bash,
 * read, write, edit — and therefore herdr).
 *
 * The operator console never consults this: it is already the privileged
 * seat. Voice shares one durable session across speakers, so builtins on
 * that session would let anyone in the call drive the machine. Text turns
 * are one-shot and keyed by the trigger actor, which is the whole
 * authority — a tools list is a boundary; the prompt around untrusted
 * channel history is not.
 */
export function discordTurnHasSystemTools(input: {
  readonly lane: CaptainSessionLaneV2;
  readonly actorId: string;
  readonly systemActorUserIds: readonly string[];
}): boolean {
  if (input.lane !== "discord_presence") return false;
  return input.systemActorUserIds.includes(input.actorId);
}
