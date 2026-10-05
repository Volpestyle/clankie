import { z } from "zod";
import { isGeneratedMediaRef, GENERATED_MEDIA_REF_PATTERN } from "./discord-presence.ts";

// ---------------------------------------------------------------------------
// Making a picture (ADR 0085).
//
// The provider and model come from operator config, never from the request: the
// operator picks with `/image-model`, and a turn chooses only what to draw. See
// `isGeneratedMediaRef` above for why the artifact this mints is attachable.
// ---------------------------------------------------------------------------

export const MEDIA_IMAGE_GENERATION_PATH = "/v1/media/images";

/**
 * Why a request produced nothing. Every one of these is a sentence he can say
 * out loud, which is the point: "I have no image model set up" is an answer,
 * where a 500 is something he would have to invent an explanation for.
 * `doctrine_denied` is a frozen unused code from the retired policy engine.
 */
export const MediaRefusalReasonSchema = z.enum([
  "doctrine_denied",
  "no_model_configured",
  "credential_unavailable",
  "provider_unsupported",
  "provider_failed",
  "artifact_too_large",
  "media_unavailable",
]);
export type MediaRefusalReason = z.infer<typeof MediaRefusalReasonSchema>;

export const GenerateImageRequestSchema = z
  .object({
    /** Use only owner-configured appearance references for self-depiction, never vibe images. */
    personaReference: z.boolean().optional(),
    schemaVersion: z.literal(1),
    prompt: z.string().trim().min(1).max(4_000),
    /** Provider-neutral shape hint; the provider and model come from operator config. */
    aspectRatio: z
      .string()
      .trim()
      .regex(/^\d{1,4}(?:\.\d)?:\d{1,4}(?:\.\d)?$/u)
      .optional(),
    /**
     * Edit this picture instead of drawing a new one.
     *
     * Restricted to media he already made: editing reads bytes back off disk,
     * and the one directory he can cause writes into is the only one safe to
     * read from without turning "change the sky" into an arbitrary file read.
     */
    sourceRef: z
      .string()
      .refine(isGeneratedMediaRef, "expected a generated-media artifact reference")
      .optional(),
  })
  .strict();
export type GenerateImageRequest = z.infer<typeof GenerateImageRequestSchema>;

/**
 * A refusal is a normal outcome he says out loud, not an exception: no image
 * model configured, no credential stored. Only `ok` carries a
 * reference, so there is no shape in which a failed generation yields something
 * attachable.
 */
export const GenerateImageResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ok"),
      schemaVersion: z.literal(1),
      artifactRef: z.string().regex(GENERATED_MEDIA_REF_PATTERN),
      filename: z.string().min(1).max(200),
      mimeType: z.string().min(1).max(100),
      byteLength: z.number().int().positive(),
      provider: z.string().min(1).max(64),
      model: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      schemaVersion: z.literal(1),
      reason: MediaRefusalReasonSchema,
      detail: z.string().max(500).optional(),
    })
    .strict(),
]);
export type GenerateImageResult = z.infer<typeof GenerateImageResultSchema>;

// ---------------------------------------------------------------------------
// Making a video (ADR 0085).
//
// A render is a job, not a response: it takes anywhere from seconds to minutes,
// so the route waits a bounded while and then hands back the job instead of
// holding a conversation open indefinitely. Passing `requestId` resumes that
// job rather than paying to render it twice, which is why resuming is the same
// call rather than a second tool he has to know about.
// ---------------------------------------------------------------------------

export const MEDIA_VIDEO_GENERATION_PATH = "/v1/media/videos";

export const GenerateVideoRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    prompt: z.string().trim().min(1).max(4_000).optional(),
    aspectRatio: z
      .string()
      .trim()
      .regex(/^\d{1,4}(?:\.\d)?:\d{1,4}(?:\.\d)?$/u)
      .optional(),
    durationSeconds: z.number().int().min(1).max(15).optional(),
    /** Resume an in-flight render started by an earlier call. */
    requestId: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.prompt === undefined) === (request.requestId === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "a video request names either a prompt to start or a requestId to resume, not both",
      });
    }
  });
export type GenerateVideoRequest = z.infer<typeof GenerateVideoRequestSchema>;

export const GenerateVideoResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ok"),
      schemaVersion: z.literal(1),
      artifactRef: z.string().regex(GENERATED_MEDIA_REF_PATTERN),
      filename: z.string().min(1).max(200),
      mimeType: z.string().min(1).max(100),
      byteLength: z.number().int().positive(),
      provider: z.string().min(1).max(64),
      model: z.string().min(1).max(200),
    })
    .strict(),
  /** Still rendering. The same call with this `requestId` picks it up. */
  z
    .object({
      outcome: z.literal("pending"),
      schemaVersion: z.literal(1),
      requestId: z.string().min(1).max(200),
      waitedSeconds: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      schemaVersion: z.literal(1),
      reason: MediaRefusalReasonSchema,
      detail: z.string().max(500).optional(),
    })
    .strict(),
]);
export type GenerateVideoResult = z.infer<typeof GenerateVideoResultSchema>;
