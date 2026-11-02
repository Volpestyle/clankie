import { z } from "zod";

/**
 * Retired: the integrate queue is gone and no service serves this path. The
 * schema stays only so clankie-app's Shipping view still compiles against this
 * sibling checkout until the app drops it; delete this module then.
 * @deprecated
 */
export const SHIPPING_PATH = "/v1/integrate/shipping";
/** @deprecated See SHIPPING_PATH. */
export const ShippingSnapshotSchema = z.object({
  batches: z.array(
    z.object({
      id: z.uuid(),
      state: z.enum([
        "queued",
        "composing",
        "conflict",
        "installing",
        "gating",
        "isolating",
        "failed",
        "passed",
        "held",
        "pushing",
        "pushed",
        "partial",
        "interrupted",
        "cancelled",
      ]),
      updatedAt: z.iso.datetime(),
      issues: z.array(z.string()),
      commits: z.array(z.string()),
      gateFailed: z.boolean(),
      waitingCount: z.number().int().nonnegative(),
    }),
  ),
});
/** @deprecated See SHIPPING_PATH. */
export type ShippingSnapshot = z.infer<typeof ShippingSnapshotSchema>;
