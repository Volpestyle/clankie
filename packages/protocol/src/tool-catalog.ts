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

export const FLEET_WORKER_CATALOG_REFRESH_PATH = "/v1/fleet/worker-tool-refresh";
export const FleetWorkerCatalogRefreshRequestSchema = z
  .object({
    paneId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export const FleetWorkerCatalogRefreshResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().min(1).max(256),
    seats: z
      .array(
        z
          .object({
            paneId: z.string().min(1).max(256),
            seatId: z.string().min(1).max(256).optional(),
            threadId: z.string().min(1).max(256).optional(),
            revision: z.string().min(1).max(256),
            outcome: z.enum(["refreshed", "catalog-refreshed", "skipped-busy", "failed"]),
            reason: z.string().max(1024).optional(),
            detail: z.string().max(2048).optional(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type FleetWorkerCatalogRefreshResult = z.infer<typeof FleetWorkerCatalogRefreshResultSchema>;

/** Deliberate operator restart; never automatic deploy recovery. */
export const FLEET_WORKER_TOOL_RESTART_PATH = "/v1/fleet/worker-tool-restart";
export const FleetWorkerToolRestartRequestSchema = z.strictObject({
  paneId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^w[\w]+:p[\w]+$/u),
  reportPath: z.string().min(1).max(4096).optional(),
});
export const FleetWorkerToolRestartResultSchema = z.strictObject({
  outcome: z.enum(["restarted", "refused", "failed"]),
  reason: z.string().max(1024).optional(),
  threadId: z.string().min(1).max(256).optional(),
  historyId: z.string().uuid().optional(),
  resumedSeatId: z.string().min(1).max(256).optional(),
});
export type FleetWorkerToolRestartRequest = z.infer<typeof FleetWorkerToolRestartRequestSchema>;
export type FleetWorkerToolRestartResult = z.infer<typeof FleetWorkerToolRestartResultSchema>;
