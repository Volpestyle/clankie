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
