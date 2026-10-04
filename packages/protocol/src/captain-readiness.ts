import { z } from "zod";

export const CAPTAIN_READINESS_PATH = "/v1/captain/readiness";
/** Setup facts only. Authentication methods and credential material never cross this boundary. */
export const CaptainReadinessResponseSchema = z.discriminatedUnion("ready", [
  z.object({
    ready: z.literal(true),
    model: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
  }),
  z.object({
    ready: z.literal(false),
    reason: z.enum(["no_model", "no_credential"]),
    model: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
  }),
]);
export type CaptainReadinessResponse = z.infer<typeof CaptainReadinessResponseSchema>;
