import { z } from "zod";

const RivalsObjectiveSchema = z
  .object({
    mode: z.enum(["autonomous", "combat", "disengage"]),
    note: z.string().trim().max(1000).default(""),
  })
  .strict();

const sessionId = z.string().regex(/^[a-f0-9]{32}$/u);
export const RivalsCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z
    .object({
      action: z.literal("start"),
      requestId: z.string().min(1).max(128),
      objective: RivalsObjectiveSchema,
      maxSeconds: z.number().int().min(1).max(1800).default(300),
    })
    .strict(),
  z.object({ action: z.literal("objective"), sessionId, objective: RivalsObjectiveSchema }).strict(),
  z.object({ action: z.literal("stop"), sessionId }).strict(),
  z.object({ action: z.literal("observe"), sessionId }).strict(),
  z
    .object({
      action: z.literal("share"),
      sessionId,
      guildId: z.string().regex(/^\d+$/u).optional(),
      channelId: z.string().regex(/^\d+$/u).optional(),
    })
    .strict(),
]);
export type RivalsCommand = z.infer<typeof RivalsCommandSchema>;

export const RivalsStatusSchema = z.object({
  schemaVersion: z.literal(1),
  execution: z.enum(["live", "replay"]),
  modes: z.array(RivalsObjectiveSchema.shape.mode),
  noteApplied: z.literal(false),
  session: z
    .object({
      id: sessionId,
      requestId: z.string(),
      phase: z.enum(["starting", "running", "stopping", "stopped", "failed"]),
      objective: RivalsObjectiveSchema,
      startedAt: z.number(),
      maxSeconds: z.number(),
      observation: z.record(z.string(), z.unknown()).nullable(),
      summary: z.record(z.string(), z.unknown()).nullable(),
      error: z.string().nullable(),
      endedAt: z.number().optional(),
    })
    .nullable(),
});
export type RivalsStatus = z.infer<typeof RivalsStatusSchema>;
