import { z } from "zod";
import { TurnModelUsageSchema } from "./model-keys.ts";

/** A provider attempt, distinct from an owner turn and from a ledger charge. */
export const TurnModelCallSchema = z
  .object({
    id: z.string().uuid(),
    sequence: z.number().int().positive(),
    phase: z.enum(["requested", "responded", "completed", "failed"]),
    preference: z.string().min(1).max(512),
    modelUsage: TurnModelUsageSchema,
    /** Provider-reported tokens; absent means unknown, never free usage. */
    tokens: z
      .object({
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
        cacheRead: z.number().int().nonnegative(),
        cacheWrite: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TurnModelCall = z.infer<typeof TurnModelCallSchema>;

/** Routing intent is never proof that its target served a model call. */
export const TurnRoutingDecisionSchema = z
  .object({
    purpose: z.enum(["operator", "discord_social", "discord_granted", "gameplay"]),
    from: z.string().min(1).max(512),
    to: z.string().min(1).max(512).optional(),
    trigger: z.enum(["asked", "looping", "provider_error"]),
    outcome: z.enum(["requested", "selected", "refused", "unavailable"]),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type TurnRoutingDecision = z.infer<typeof TurnRoutingDecisionSchema>;
