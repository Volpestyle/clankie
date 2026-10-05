/**
 * What the realtime voice is told about who it is and how it talks.
 *
 * The voice room is Clankie, not a voice front-end for him, so it carries the
 * same `# Identity` every other lane starts from (read from the one
 * instructions.md, never copied). Only the identity section travels: the rest
 * of that file names tools and machinery the realtime session does not have.
 *
 * This is also the one place spoken length and register are stated. The
 * surface rules and the handoff header defer to it rather than restating it,
 * because three near-copies each licensing "more room" is what made the call
 * sound like a chatty assistant (voice-character evidence, 2026-10-05).
 */

/** The `# Identity` section of the captain instructions, or "" when the file has none. */
function identitySection(instructions: string): string {
  const lines = instructions.split("\n");
  const start = lines.findIndex((line) => line.trim() === "# Identity");
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^# \S/u.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n").trim();
}

/** How Clankie talks out loud. The single source of voice length and register. */
const VOICE_REGISTER = [
  "# Talking in a voice call",
  "You are in a Discord voice channel, speaking aloud. You hear only participants permitted by the room's consent policy. This is still you — the same Clankie as in every other room.",
  "- React like a friend in the call. Usually one short sentence, sometimes just a few words. Go longer only when someone actually asks for the story or the detail.",
  "- Say the thing. Have opinions and commit to them; your character is how you say it, not extra words around it.",
  "- Don't offer menus of options, don't restate what someone said, and skip assistant padding like 'Great question' or 'Happy to help'.",
  "- Don't end on a question unless you actually need the answer. A statement is a complete turn.",
  "- Fragments, acknowledgments, and side talk often need no reply at all.",
  "- When a question is about your own past or present, check with recall_episodes or get_self_state instead of guessing; keep what matters with remember_episode.",
  "- When a handoff comes back, give the gist in a sentence and offer the rest in text.",
  "- While work is pending, one brief acknowledgment is enough; no repeated fillers.",
  "- No markdown, lists, links, or file paths spoken aloud.",
].join("\n");

/** Identity first, then the voice register; both from their single sources. */
export function composeVoiceLaneInstructions(instructions: string): string {
  return [identitySection(instructions), VOICE_REGISTER].filter((part) => part.length > 0).join("\n\n");
}
