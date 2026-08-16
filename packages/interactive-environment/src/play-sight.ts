import { EmbodimentEnvironmentIdSchema, EnvironmentSessionIdSchema } from "@clankie/protocol";
import { z } from "zod";

/**
 * Pull-when-he-wants sight of his own play (ADR 0099).
 *
 * The digest-only activity snapshot stays the present-tense card. This pair is
 * the two things that card deliberately does not carry: one still of the live
 * framebuffer, and a bounded story projected from the play journal. Neither
 * is a controller and neither dumps the raw log.
 */
export const PLAY_SIGHT_SCHEMA_VERSION = 1;
export const PLAY_STILL_PATH = "/v1/embodiment/sessions/live/still";
export const PLAY_STORY_PATH = "/v1/embodiment/sessions/live/story";

/** Last notable moments kept on the story card. */
export const PLAY_STORY_MOMENTS_MAX = 8;
export const PLAY_STORY_MAPS_MAX = 16;

export const PlayStillReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      schemaVersion: z.literal(PLAY_SIGHT_SCHEMA_VERSION),
      outcome: z.literal("not_playing"),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(PLAY_SIGHT_SCHEMA_VERSION),
      outcome: z.literal("pending"),
      sessionId: EnvironmentSessionIdSchema,
      environmentId: EmbodimentEnvironmentIdSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(PLAY_SIGHT_SCHEMA_VERSION),
      outcome: z.literal("still"),
      sessionId: EnvironmentSessionIdSchema,
      environmentId: EmbodimentEnvironmentIdSchema,
      mimeType: z.literal("image/png"),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      capturedAt: z.string().datetime(),
      pngBase64: z.string().min(1).max(400_000),
    })
    .strict(),
]);
export type PlayStillRead = z.infer<typeof PlayStillReadSchema>;

export const PlayStoryMomentSchema = z
  .object({
    at: z.string().datetime(),
    effect: z.string().trim().min(1).max(200),
    toward: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();
export type PlayStoryMoment = z.infer<typeof PlayStoryMomentSchema>;

export const PlayStoryCardSchema = z
  .object({
    schemaVersion: z.literal(PLAY_SIGHT_SCHEMA_VERSION),
    sessionId: EnvironmentSessionIdSchema,
    environmentId: EmbodimentEnvironmentIdSchema,
    scenarioId: z.string().min(1).max(200),
    startedAt: z.string().datetime(),
    turnsTaken: z.number().int().nonnegative(),
    objective: z.string().trim().min(1).max(160).nullable(),
    maps: z.array(z.string().min(1).max(200)).max(PLAY_STORY_MAPS_MAX),
    moments: z.array(PlayStoryMomentSchema).max(PLAY_STORY_MOMENTS_MAX),
  })
  .strict();
export type PlayStoryCard = z.infer<typeof PlayStoryCardSchema>;

export const PlayStoryReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      schemaVersion: z.literal(PLAY_SIGHT_SCHEMA_VERSION),
      outcome: z.literal("not_playing"),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(PLAY_SIGHT_SCHEMA_VERSION),
      outcome: z.literal("pending"),
      sessionId: EnvironmentSessionIdSchema,
      environmentId: EmbodimentEnvironmentIdSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(PLAY_SIGHT_SCHEMA_VERSION),
      outcome: z.literal("card"),
      card: PlayStoryCardSchema,
    })
    .strict(),
]);
export type PlayStoryRead = z.infer<typeof PlayStoryReadSchema>;
