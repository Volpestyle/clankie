import { FLEET_HEALTH_METRICS_PATH, FleetHealthMetricsSnapshotSchema } from "@clankie/protocol";
import type { Hono } from "hono";
import { authenticateOperator } from "./http-auth.ts";
import type { ClankieAppDependencies } from "./types.ts";

export function registerFleetHealthMetricsRoutes(app: Hono, dependencies: ClankieAppDependencies) {
  app.get(FLEET_HEALTH_METRICS_PATH, async (context) => {
    const identity = await authenticateOperator(context.req.raw, dependencies);
    if (identity === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!identity) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.fleetHealthMetrics) return context.json({ error: "fleet_metrics_unavailable" }, 503);
    return context.json(
      FleetHealthMetricsSnapshotSchema.parse(dependencies.fleetHealthMetrics.snapshot()),
      200,
      { "cache-control": "no-store" },
    );
  });
}
