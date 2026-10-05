import { z } from "zod";
import { CaptainSessionLaneV2Schema } from "./captain-lanes.ts";
import { DiscordPersonIdentitySchema, DiscordPersonMemoryFactSchema } from "./discord-person-memory.ts";

// ---------------------------------------------------------------------------
// Captain episodes (ADR 0054).
//
// The second memory trust class. A `MemoryFact` is a claim about the world and
// enters memory only through an approval envelope; an episode is Clankie's own
// note about his own activity, so it is written without one. Keeping them in
// separate shapes is what lets the world-fact fences stay closed while he still
// remembers having been somewhere.
// ---------------------------------------------------------------------------

/** Where an episode may resurface. There is no "public only" scope: a room he was in already knows. */
export const CaptainEpisodeVisibilitySchema = z.enum(["shareable", "operator_private"]);
export type CaptainEpisodeVisibility = z.infer<typeof CaptainEpisodeVisibilitySchema>;

export const CAPTAIN_EPISODE_SUMMARY_MAX = 512;

export const CaptainEpisodeSchema = z
  .object({
    schemaVersion: z.literal(1),
    episodeId: z.string().trim().min(1).max(256),
    /** Host-stamped stable origin. Missing on legacy records; never inferred from a persona. */
    sourceConversationId: z.string().trim().min(1).max(256).optional(),
    /** The room it happened in, so recall can say where without holding its transcript. */
    lane: CaptainSessionLaneV2Schema,
    targetId: z.string().trim().min(1).max(512),
    summary: z.string().trim().min(1).max(CAPTAIN_EPISODE_SUMMARY_MAX),
    visibility: CaptainEpisodeVisibilitySchema,
    /**
     * Lifts this note out of the recent ring into the durable set, where newer
     * episodes cannot evict it. Optional with a default, so every episode
     * written before retention existed loads as an unretained recent one.
     */
    retained: z.boolean().default(false),
    /** Set when a stale note was superseded in place; its source and date are never rewritten. */
    correctedAt: z.string().datetime().optional(),
    provenance: z
      .object({
        characterId: z.string().trim().min(1).max(512),
        sessionId: z.string().trim().min(1).max(512),
        /**
         * Structural assertions, not descriptions. An episode is Clankie
         * summarizing himself; anything asserting a fact about the world belongs
         * in `MemoryFactSchema` behind its approval gate, and raw untrusted text
         * never becomes durable memory in either shape.
         */
        selfAuthored: z.literal(true),
        rawTranscript: z.literal(false),
      })
      .strict(),
    occurredAt: z.string().datetime(),
  })
  .strict();
export type CaptainEpisode = z.infer<typeof CaptainEpisodeSchema>;

/** Owner curation may change the note, its reach, or whether it lasts — never its room or provenance. */
export const CaptainEpisodeEditSchema = z
  .object({
    summary: z.string().trim().min(1).max(CAPTAIN_EPISODE_SUMMARY_MAX).optional(),
    visibility: CaptainEpisodeVisibilitySchema.optional(),
    retained: z.boolean().optional(),
  })
  .strict()
  .refine((edit) => Object.keys(edit).length > 0, "an edit must change at least one field");
export type CaptainEpisodeEdit = z.infer<typeof CaptainEpisodeEditSchema>;

/** Complete owner-only browse view; ambient callers only receive bounded recall cards. */
export const OperatorMemoryCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    discordPeople: z.array(
      z
        .object({
          subject: DiscordPersonIdentitySchema,
          facts: z.array(DiscordPersonMemoryFactSchema).max(128),
        })
        .strict(),
    ),
    captainEpisodes: z.array(CaptainEpisodeSchema),
    /** What the durable shelf holds and how much room is left before a retain is refused. */
    retention: z
      .object({
        retained: z.number().int().nonnegative(),
        capacity: z.number().int().positive(),
        recentCapacity: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type OperatorMemoryCatalog = z.infer<typeof OperatorMemoryCatalogSchema>;
