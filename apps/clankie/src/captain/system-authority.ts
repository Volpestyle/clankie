import type { CaptainSessionLaneV2 } from "@clankie/protocol";

/**
 * Whether this Discord turn may use the operator's machine tools (bash,
 * read, write, edit — and therefore herdr).
 *
 * The operator console never consults this: it is already the privileged
 * seat. Text and voice both key on the trigger actor, which is the whole
 * authority — a tools list is a boundary; the prompt around untrusted channel
 * history is not. Both actor ids are Discord-gateway authenticated: a text
 * turn's from the message author, a voice turn's from the per-user audio
 * stream that produced the transcript, never inferred from the audio itself.
 *
 * Gameplay is not a room anyone talks to him from, so it never grants.
 */
export function discordTurnHasSystemTools(input: {
  readonly lane: CaptainSessionLaneV2;
  readonly actorId: string;
  readonly systemActorUserIds: readonly string[];
}): boolean {
  if (input.lane !== "discord_presence" && input.lane !== "discord_voice") return false;
  return input.systemActorUserIds.includes(input.actorId);
}

/**
 * Whether a turn runs on its lane's shared durable session.
 *
 * Voice keeps one durable session per channel, shared by every speaker in it.
 * Builtins are bound when that session is built, so granting them for an
 * allowlisted speaker would leave them attached to the session for whoever
 * talks next — the grant would outlive the actor who earned it. A privileged
 * turn therefore always runs one-shot, exactly as a privileged text turn
 * already does: the tools last one turn and answer to one authenticated actor.
 */
export function discordTurnUsesDurableSession(input: {
  readonly durable: boolean;
  readonly systemTools: boolean;
}): boolean {
  return input.durable && !input.systemTools;
}
