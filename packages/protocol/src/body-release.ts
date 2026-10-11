import { z } from "zod";

/**
 * The managed fleet's approved release for a body (ADR 0237). A body installs
 * nothing newer; `null` holds it in place. Signed like every body route.
 */
export const FLEET_BODY_RELEASE_PATH = "/fleet/v1/body/release";
export const BodyReleaseSchema = z
  .object({
    approved: z
      .string()
      .regex(/^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$/u)
      .nullable(),
  })
  .strict();
export type BodyRelease = z.infer<typeof BodyReleaseSchema>;

/** Local release helper's final, exact-operation idle check (ADR 0237). */
export const SCHEDULED_RELEASE_CUTOVER_PATH = "/v1/runtime-update/cutover";
export const ScheduledReleaseCutoverRequestSchema = z.strictObject({
  operationId: z.string().uuid(),
  instanceId: z.string().uuid(),
});
export const ScheduledReleaseCutoverResultSchema = z.discriminatedUnion("outcome", [
  ScheduledReleaseCutoverRequestSchema.extend({ outcome: z.literal("ready") }),
  ScheduledReleaseCutoverRequestSchema.extend({
    outcome: z.literal("waiting"),
    reason: z.enum(["disabled", "body-busy"]),
  }),
]);
export type ScheduledReleaseCutoverResult = z.infer<typeof ScheduledReleaseCutoverResultSchema>;
