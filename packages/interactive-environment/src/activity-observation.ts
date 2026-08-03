import {
  EmbodimentEnvironmentIdSchema,
  EmbodimentSessionStateSchema,
  EnvironmentSessionIdSchema,
} from "@clankie/protocol";
import { z } from "zod";

/**
 * Latest-only self-observation for an activity Clankie is currently doing.
 *
 * This is deliberately not an environment action surface and not a transcript.
 * The runner reduces one settled gameplay turn into this bounded shape so a
 * captain in another lane can answer questions about his own activity without
 * receiving another lane's continuation token, prompt, raw decoded state, or
 * unbounded model output.
 */
export const ACTIVITY_OBSERVATION_SCHEMA_VERSION = 1;

const boundedNullableText = (maximum: number) => z.string().max(maximum).nullable();

export const GbaActivityObservationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(ACTIVITY_OBSERVATION_SCHEMA_VERSION),
    surface: z.literal("gba_emulator"),
    sessionId: EnvironmentSessionIdSchema,
    environmentId: z.literal("pokemon-firered"),
    /** Monotonic settled free-play turn within this activity session. */
    sequence: z.number().int().nonnegative(),
    observedAt: z.string().datetime(),
    /**
     * Clankie's own bounded gameplay output. It is useful self-knowledge, but
     * remains model-authored rather than runner authority.
     */
    selfAuthored: z
      .object({
        objective: boundedNullableText(160),
        intent: boundedNullableText(200),
        commentary: boundedNullableText(600),
      })
      .strict(),
    /** Facts the runner derived after the action settled. */
    runnerObserved: z
      .object({
        outcome: z.enum(["accepted", "rejected_by_adapter", "invalid_decision", "mind_failed"]),
        effect: boundedNullableText(200),
        progress: z
          .object({
            distinctTiles: z.number().int().nonnegative(),
            maps: z.array(z.string().min(1).max(200)).max(64),
            turnsSinceNewTile: z.number().int().nonnegative(),
            actionsPerNewTile: z.number().nonnegative().nullable(),
          })
          .strict(),
        /** Digest only. Frame bytes stay on the rendered-surface media plane. */
        framebufferSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type GbaActivityObservationSnapshot = z.infer<typeof GbaActivityObservationSnapshotSchema>;

export const ActivityObservationSnapshotSchema = z.discriminatedUnion("surface", [
  GbaActivityObservationSnapshotSchema,
]);
export type ActivityObservationSnapshot = z.infer<typeof ActivityObservationSnapshotSchema>;

/**
 * Public read result from the control plane. `pending` means the runner owns a
 * live session but no turn has settled yet; it is not permission to guess.
 */
export const ActivityObservationReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      schemaVersion: z.literal(ACTIVITY_OBSERVATION_SCHEMA_VERSION),
      outcome: z.literal("snapshot"),
      snapshot: ActivityObservationSnapshotSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(ACTIVITY_OBSERVATION_SCHEMA_VERSION),
      outcome: z.literal("pending"),
      sessionId: EnvironmentSessionIdSchema,
      environmentId: EmbodimentEnvironmentIdSchema,
      state: EmbodimentSessionStateSchema,
      updatedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(ACTIVITY_OBSERVATION_SCHEMA_VERSION),
      outcome: z.literal("not_playing"),
    })
    .strict(),
]);
export type ActivityObservationRead = z.infer<typeof ActivityObservationReadSchema>;
