import { z } from "zod";

export const FLEET_LEADS_PATH = "/v1/fleet/leads";
export const FleetLeadSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["clankie", "app"]),
    name: z.string().min(1),
    active: z.boolean(),
    lastActiveAt: z.string().datetime().optional(),
  })
  .strict();
export const FleetLeadsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: z.string().datetime(),
    leads: z.array(FleetLeadSchema),
  })
  .strict();
export type FleetLead = z.infer<typeof FleetLeadSchema>;
export type FleetLeadsSnapshot = z.infer<typeof FleetLeadsSnapshotSchema>;
