import { FLEET_SEAT_RESTARTS_PATH, SeatRestartStatusSchema } from "@clankie/protocol";
import type { Hono } from "hono";
import { authenticateOperator } from "./http-auth.ts";
import type { ClankieAppDependencies } from "./types.ts";

export function registerSeatRestartRoutes(app: Hono, dependencies: ClankieAppDependencies) {
  app.get(FLEET_SEAT_RESTARTS_PATH, async (context) => {
    const identity = await authenticateOperator(context.req.raw, dependencies);
    if (identity === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!identity) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.captain.seatRestartStatus)
      return context.json({ error: "seat_restart_unavailable" }, 503);
    return context.json(SeatRestartStatusSchema.parse(await dependencies.captain.seatRestartStatus()), 200, {
      "cache-control": "no-store",
    });
  });
}
