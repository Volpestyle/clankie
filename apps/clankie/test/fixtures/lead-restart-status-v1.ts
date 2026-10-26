// Frozen response schema from 251de1c794876d5c2dbf02caf1a6f8d1a3081e78.
// Keep the old reader independent of later producer schema changes (VUH-2849).
import { z } from "zod";

export const PreviousLeadRestartStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: z.string().min(1).max(256),
    setting: z.enum(["on", "off"]),
    /** The restart is due at either bound. */
    budget: z
      .object({ contextTokens: z.number().int().positive(), ageHours: z.number().positive() })
      .strict(),
    /** A due restart refused this long tells the owner once. */
    noticeAfterMinutes: z.number().int().positive(),
    /** The latest check since the service started; absent before the first. */
    check: z
      .object({
        at: z.string().datetime(),
        contextTokens: z.number().int().nonnegative().optional(),
        sessionStartedAt: z.string().datetime().optional(),
        due: z.boolean(),
      })
      .strict()
      .optional(),
    /** A due restart refused since `since`, kept across service restarts until it relaunches or is no longer due. */
    waiting: z
      .object({
        since: z.string().datetime(),
        lastAt: z.string().datetime(),
        lastReason: z.string().min(1).max(64),
        lastDetail: z.string().max(512).optional(),
        counts: z.record(z.string().min(1).max(64), z.number().int().positive()),
        noticedAt: z.string().datetime().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
