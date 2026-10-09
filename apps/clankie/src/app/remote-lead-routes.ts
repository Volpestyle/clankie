import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RemoteLeadLaunchSchema } from "@clankie/protocol/remote-leads";
import type { ClankieAppDependencies } from "./types.ts";
import { authenticateOperator } from "./http-auth.ts";
import { createRemoteLeadBridge } from "../remote-lead-bridge.ts";

export function remoteLeadRoutes(dependencies: ClankieAppDependencies) {
  const app = new Hono();
  const leads = dependencies.remoteProjectLeads;
  const bridge = leads && createRemoteLeadBridge({
    captain: dependencies.captain,
    delegations: leads.delegations,
    identity: (request) => dependencies.fleetLinks?.identity?.(request),
    ...(dependencies.seatCallReceiptPath === undefined ? {} : { receiptPath: dependencies.seatCallReceiptPath }),
  });
  if (bridge) app.route("/", bridge.app);
  app.use("/v1/remote-leads/*", bodyLimit({ maxSize: 16 * 1024 }));
  app.post("/v1/remote-leads/:action", async (context) => {
    const identity = await authenticateOperator(context.req.raw, dependencies);
    if (!identity || identity === "unavailable") return context.json({ error: "operator_authentication_required" }, 401);
    if (!leads) return context.json({ error: "remote_leads_unavailable" }, 503);
    const guard = async () => {
      const current = await authenticateOperator(context.req.raw, dependencies);
      if (!current || current === "unavailable" || current.operatorId !== identity.operatorId)
        throw new Error("operator_revoked");
    };
    const input = await context.req.json().catch(() => undefined);
    const action = context.req.param("action");
    if (action === "launch") {
      const parsed = RemoteLeadLaunchSchema.safeParse(input);
      if (!parsed.success) return context.json({ error: "invalid_remote_lead_launch" }, 400);
      return context.json(await leads.launch(parsed.data, guard));
    }
    if (action === "prepare" && input && Object.keys(input).length === 1 &&
        typeof input.fleet === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(input.fleet)) {
      await guard();
      return context.json(await leads.prepare(input.fleet));
    }
    if (action === "revoke" && input && Object.keys(input).length === 1 &&
        typeof input.delegationId === "string") {
      await guard();
      return context.json({ revoked: leads.delegations.revoke(input.delegationId) });
    }
    return context.json({ error: "invalid_remote_lead_request" }, 400);
  });
  return { app, close: () => bridge?.close() };
}
