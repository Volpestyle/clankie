import { defineTool } from "eve/tools";
import { z } from "zod";
import { GenerateImageRequestSchema, isGeneratedMediaRef } from "@clankie/protocol";
import { controlPlaneClient } from "../../lib/client.ts";

/**
 * Drawing something (ADR 0085).
 *
 * Authored here rather than resolved dynamically like the browser: there is one
 * call with one shape, and the provider behind it is operator config the model
 * has no business naming. He says what to draw; the control plane decides what
 * that costs.
 *
 * He is told the picture attaches itself. That is true in a Discord channel,
 * where the turn's own reply carries it, and it is the reason the tool takes no
 * channel argument — a tool that let him choose where a picture lands would be
 * a publish surface, which this deliberately is not.
 */
export default defineTool({
  description:
    "Draw a picture. Describe what you want in the prompt as fully as you like — subject, style, mood, colours. " +
    "You can also change a picture you made earlier by passing its sourceRef along with what to change. " +
    "In a Discord channel the picture is attached to your reply automatically, so make it and then talk about " +
    "it normally; never paste the reference into your message. The result tells you what happened: 'ok' means " +
    "you made it, 'refused' names a reason you can say out loud — 'no_model_configured' means nobody has picked " +
    "an image model yet (/image-model), 'credential_unavailable' means there is no API key stored for it. " +
    "A refusal is something to mention, not retry.",
  inputSchema: GenerateImageRequestSchema.omit({ schemaVersion: true }).extend({
    aspectRatio: z
      .string()
      .trim()
      .regex(/^\d{1,4}(?:\.\d)?:\d{1,4}(?:\.\d)?$/u)
      .optional()
      .describe("Shape of the picture, like 16:9 or 1:1. Omit to let the model choose."),
    // Same constraint as the route, restated because `.extend` replaces the
    // field rather than decorating it — a bare string here would turn a bad
    // reference into a 400 he has to interpret instead of a validation message.
    sourceRef: z
      .string()
      .refine(isGeneratedMediaRef, "expected the artifactRef from an earlier generate_image result")
      .optional()
      .describe("The reference from an earlier generate_image result, to edit that picture instead."),
  }),
  async execute(input) {
    return controlPlaneClient().generateImage({ schemaVersion: 1, ...input });
  },
});
