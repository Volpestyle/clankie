import { defineTool } from "eve/tools";
import { z } from "zod";
import { CAPTAIN_EPISODE_SUMMARY_MAX } from "@clankie/protocol";

/**
 * Composes a note; it does not write one.
 *
 * The write happens in the `captain-episodes` hook, because the room an episode
 * belongs to must not be something the model can state. A tool executor
 * receives the AI SDK's options rather than the eve session context, so it
 * cannot see its own lane — and a tool that accepted one as an argument would
 * let a prompt-injected turn file a Discord episode as though it happened in
 * the operator conversation. The hook has the trusted channel and stamps it.
 */
export default defineTool({
  description:
    "Keep a short note about what you have just been doing, so you still have it in your other rooms. Your own activity only — not facts about the world or about people, which need an approved memory proposal. Say what happened in one or two sentences.",
  inputSchema: z.object({
    summary: z.string().trim().min(1).max(CAPTAIN_EPISODE_SUMMARY_MAX),
    visibility: z
      .enum(["shareable", "operator_private"])
      .optional()
      .describe(
        "Omit to use the safe default for the room you are in. Mark operator_private for anything from an operator conversation that should never resurface in a Discord channel.",
      ),
  }),
  execute(input) {
    return input;
  },
});
