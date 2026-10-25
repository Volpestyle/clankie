import { FLEET_LEAD_RESTART_PATH, LeadRestartStatusSchema } from "@clankie/protocol";
import type { Hono } from "hono";
import { authenticateOperator } from "./http-auth.ts";
import type { ClankieAppDependencies } from "./types.ts";

/** The default lead seat's fresh restart, read-only (VUH-2821). */
export function registerLeadRestartRoutes(app: Hono, dependencies: ClankieAppDependencies) {
  app.get(FLEET_LEAD_RESTART_PATH, async (context) => {
    const identity = await authenticateOperator(context.req.raw, dependencies);
    if (identity === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!identity) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.captain.leadRestartStatus)
      return context.json({ error: "lead_restart_unavailable" }, 503);
    return context.json(LeadRestartStatusSchema.parse(await dependencies.captain.leadRestartStatus()), 200, {
      "cache-control": "no-store",
    });
  });
}
