import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";

/**
 * Rendering a clip (ADR 0085).
 *
 * The one place the media tools differ from every other tool he has: a render
 * outlasts a conversational turn, so `pending` is a first-class result rather
 * than a failure. He is told to say so and come back with the same requestId,
 * because the alternative — retrying with the prompt — silently pays twice for
 * one clip.
 */
export default defineTool({
  description:
    "Make a short video clip. Describe the motion and the scene in the prompt. Clips take a while: " +
    "'pending' means it is still rendering and is completely normal — say so in your own words, and later call " +
    "this again with that same requestId (and no prompt) to pick it up. Never start a second render of the same " +
    "idea; that pays for it twice. 'ok' means it is done, and in a Discord channel it attaches to your reply " +
    "automatically. 'refused' names a reason you can say out loud, like 'no_model_configured' (/video-model) or " +
    "'artifact_too_large' (it came out too big to post — try a shorter clip).",
  inputSchema: z
    .object({
      prompt: z
        .string()
        .trim()
        .min(1)
        .max(4_000)
        .optional()
        .describe("What happens in the clip. Omit only when resuming with a requestId."),
      aspectRatio: z
        .string()
        .trim()
        .regex(/^\d{1,4}(?:\.\d)?:\d{1,4}(?:\.\d)?$/u)
        .optional()
        .describe("Shape of the clip, like 16:9 or 9:16."),
      durationSeconds: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .describe("How long the clip runs, 1 to 15 seconds. Shorter renders faster and posts more reliably."),
      requestId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("From an earlier 'pending' result, to pick that render up instead of starting a new one."),
    })
    .strict(),
  async execute(input) {
    return controlPlaneClient().generateVideo({ schemaVersion: 1, ...input });
  },
});
