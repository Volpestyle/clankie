import { z } from "zod";

/** Native client acceptance evidence, not a grant or a bridge's advertised list. */
export const FleetSeatToolCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    harness: z.enum(["claude", "codex"]),
    sessionId: z.string().trim().min(1).max(256),
    bridge: z.enum(["worker", "operator"]),
    conversationId: z.string().trim().min(1).max(256).optional(),
    tools: z.array(z.string().trim().min(1).max(256)).max(4096),
    checkedAt: z.string().datetime({ offset: true }),
    error: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type FleetSeatToolCatalog = z.infer<typeof FleetSeatToolCatalogSchema>;

export const FleetSeatToolCatalogHealthSchema = z
  .object({
    status: z.enum(["matched", "mismatch", "unverified"]),
    detail: z.string().max(4096),
    missing: z.array(z.string().max(256)).max(4096),
    remediation: z.string().max(2048).optional(),
    harness: z.enum(["claude", "codex"]),
    sessionId: z.string().max(256).optional(),
    bridge: z.enum(["worker", "operator"]),
    checkedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type FleetSeatToolCatalogHealth = z.infer<typeof FleetSeatToolCatalogHealthSchema>;

export const FLEET_SEAT_TOOL_CATALOG_PATH = "/v1/fleet/seats/:paneId/tool-catalog";
export function fleetSeatToolCatalogPath(paneId: string): string {
  return `/v1/fleet/seats/${encodeURIComponent(paneId)}/tool-catalog`;
}
export const FLEET_TOOL_CATALOG_HEALTH_PATH = "/v1/fleet/tool-catalog-health";
export const FleetToolCatalogHealthPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    seats: z
      .array(
        z
          .object({
            paneId: z.string(),
            seatId: z.string(),
            toolCatalog: FleetSeatToolCatalogHealthSchema,
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type FleetToolCatalogHealthPage = z.infer<typeof FleetToolCatalogHealthPageSchema>;
