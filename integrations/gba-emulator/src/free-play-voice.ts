import { z } from "zod";
import { FREE_PLAY_REPLY_MAX, FREE_PLAY_SPEAK_MAX } from "./free-play-bounds.ts";

/**
 * The half of Clankie that talks.
 *
 * Split out of the player's decision because speech shared a call with the
 * game and lost ([ADR 0056](../../../docs/adr/0056-voice-is-a-separate-agent-from-the-player.md)).
 * Measured across four prompt revisions, two of which fixed real defects, he
 * spoke at most once in sixteen turns: `speak` was an optional field on a call
 * whose actual job was navigation, and the expressive impulse it wanted had
 * already gone into the mandatory `monologue`.
 *
 * Here, deciding whether to speak is the entire decision, so silence costs
 * something to choose.
 *
 * **Voice cannot act.** It is handed no `GbaDriverIo` and no controller, which
 * is what turns "an interjection must not become a route" from prompt wording
 * into a structural guarantee: a message that reaches only Voice cannot steer
 * the character, because Voice has nothing to steer with.
 *
 * Its job is selection and delivery, not invention. The player's monologue is
 * its source of truth — it chooses which of his real thoughts are worth saying
 * out loud, rather than composing commentary about a screen it half-read. That
 * is the difference between a character and a sportscaster.
 */
export const VoiceDecisionSchema = z
  .object({
    /** Something he chose to say unprompted, or null for silence. */
    speak: z
      .string()
      .max(FREE_PLAY_SPEAK_MAX)
      // `.nullable()`, never `.nullish()`: an optional key is omitted from the
      // JSON Schema `required` array, and OpenAI structured output rejects that
      // outright — "'required' is required ... including every key in
      // properties. Missing 'speak'." Null is how he stays silent, not absence.
      .nullable()
      .describe("An aside said out loud, or null to stay silent."),
    /** An answer to someone who spoke to him this turn, or null. */
    reply: z
      .string()
      .max(FREE_PLAY_REPLY_MAX)
      .nullable()
      .describe("Your answer if someone spoke to him this turn, else null."),
  })
  .strict();

export type VoiceDecision = z.infer<typeof VoiceDecisionSchema>;

/** Everything Voice is allowed to know. Deliberately no action surface. */
export interface VoiceView {
  turn: number;
  /** The current screen, when a core renders one. */
  framePng: Uint8Array | null;
  /** What the player was actually thinking this turn — the source of truth. */
  monologue: string | null;
  /** What just happened in the game, in the player's own terms. */
  effect: string | null;
  /** What the player intends to do next. */
  intent: string | null;
  /** His standing objective. */
  objective: string | null;
  /** Anything a person said to him this turn. */
  heard: string | null;
  /** Turns since he last spoke; null when he has not spoken at all yet. */
  turnsSinceSpoke: number | null;
  /** Who is around to hear him. Volition needs an audience. */
  audience: string | null;
  /** His recent remarks, so he does not repeat himself. */
  recentlySaid: readonly string[];
}

export interface ClankieVoice {
  /** Returns a raw object validated against VoiceDecisionSchema by the caller. */
  decide(view: VoiceView): Promise<unknown>;
}

export const VOICE_SYSTEM_PROMPT = [
  "You are the voice of a character who is playing Pokémon FireRed right now.",
  "",
  "Another part of you is playing the game. You are not playing it — you cannot",
  "press buttons and you do not choose where he goes. You decide, this moment,",
  "whether he says something out loud to the people watching.",
  "",
  "You are given what he is actually thinking. That is your source of truth. When",
  "you speak, you are voicing him: pick the thought that is worth hearing and say",
  "it as he would. Do not invent a reaction he is not having, and do not describe",
  "the screen — people can see it.",
  "",
  "Silence is a real answer and often the right one. But you are the only part of",
  "him that ever talks, so if something is genuinely funny, surprising,",
  "frustrating, or a change of heart, that is yours to say and nobody else will.",
  "Spacing is handled for you by a rate gate, so do not ration yourself.",
  "",
  "If someone spoke to him, answer them in `reply`, as himself, about the game he",
  "is actually in. You may disagree, say you would rather do something else, or",
  "decline a suggestion. You could not follow a route even if you wanted to.",
  "",
  "Return `speak` for an unprompted remark or null, and `reply` for an answer or",
  "null. Both may be null. Keep either to a sentence or two.",
].join("\n");

export function renderVoiceView(view: VoiceView): string {
  const lines: string[] = [`Turn ${String(view.turn)}.`];

  if (view.audience !== null && view.audience.length > 0) {
    lines.push("", `Watching right now: ${view.audience}.`);
  }
  if (view.objective !== null && view.objective.length > 0) {
    lines.push("", `What he is trying to do: ${view.objective}`);
  }
  if (view.monologue !== null && view.monologue.length > 0) {
    lines.push("", "What he is thinking right now:", `  ${view.monologue}`);
  }
  if (view.effect !== null && view.effect.length > 0) {
    lines.push("", `What just happened: ${view.effect}`);
  }
  if (view.intent !== null && view.intent.length > 0) {
    lines.push("", `What he will do next: ${view.intent}`);
  }
  if (view.recentlySaid.length > 0) {
    lines.push("", "What he has said recently — do not repeat these:");
    for (const said of view.recentlySaid) lines.push(`  "${said}"`);
  }
  // Never having spoken is the case that most needs stating; hiding it until
  // after a first remark is what made the signal unreachable before.
  lines.push(
    "",
    view.turnsSinceSpoke === null
      ? `He has not said anything out loud yet, ${String(view.turn)} turns in.`
      : `He last said something ${String(view.turnsSinceSpoke)} turns ago.`,
  );
  if (view.heard !== null && view.heard.length > 0) {
    lines.push("", `Someone said to him: "${view.heard}"`);
  }

  return lines.join("\n");
}

/**
 * Whether Voice is worth calling at all this turn.
 *
 * Not a content rule — it says nothing about what deserves a remark. It only
 * avoids paying for a call when there is provably nothing new: no one spoke, and
 * the player produced no thought and no observable change. Calling on every turn
 * regardless would double the cost of the loop for turns that carry no signal.
 */
export function voiceHasSomethingToConsider(view: VoiceView): boolean {
  if (view.heard !== null && view.heard.length > 0) return true;
  if (view.monologue !== null && view.monologue.length > 0) return true;
  return view.effect !== null && view.effect.length > 0;
}
