import { z } from "zod";

export const FLEET_LEADS_PATH = "/v1/fleet/leads";
export const FleetLeadTouchSchema = z
  .object({
    seatId: z.string().min(1),
    occupantId: z.string().min(1),
    kind: z.enum(["hire", "message", "answer", "close"]),
    at: z.string().datetime(),
  })
  .strict();
export type FleetLeadTouch = z.infer<typeof FleetLeadTouchSchema>;
export const FleetLeadSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["clankie", "app"]),
    name: z.string().min(1),
    active: z.boolean(),
    channel: z.string().trim().min(1).max(64).optional(),
    appId: z.string().min(1).optional(),
    hires: z
      .array(z.object({ seatId: z.string().min(1), occupantId: z.string().min(1) }).strict())
      .optional(),
    touches: z.array(FleetLeadTouchSchema).max(20).optional(),
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
