import { z } from "zod";

/** Advice only: host-reported capacity neither reserves resources nor grants a hire. */
export const HireRecommendationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("recommended"),
    machine: z.string().min(1).max(200),
    project: z.string().min(1).max(100),
    workingDirectory: z.string().min(1).max(4096),
    harness: z.enum(["claude", "codex"]),
    account: z.string().min(1).max(128),
    reason: z.string().min(1).max(600),
    unknown: z.array(z.enum(["context", "load", "disk"])).max(3),
  }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.string().min(1).max(600) }),
]);
export type HireRecommendation = z.infer<typeof HireRecommendationSchema>;
