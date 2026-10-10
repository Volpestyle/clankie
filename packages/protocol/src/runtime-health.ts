import { z } from "zod";

/** Process counters only. 100% CPU means one core; consumers difference one boot's samples. */
export const ProcessHealthSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  instanceId: z.uuid(),
  pid: z.number().int().safe().min(2),
  uptimeMs: z.number().finite().nonnegative(),
  cpu: z.strictObject({
    userMicros: z.number().int().safe().nonnegative(),
    systemMicros: z.number().int().safe().nonnegative(),
  }),
});
export type ProcessHealthSnapshot = z.infer<typeof ProcessHealthSnapshotSchema>;
