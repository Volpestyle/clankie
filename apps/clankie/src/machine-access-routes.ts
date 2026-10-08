import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { OperatorAuthenticator } from "./app/types.ts";
import type { Machines } from "./machines.ts";

/** Owner command surface; joined hosts and workers receive no setter authority. */
export function createMachineAccessRoutes(options: {
  machines?: Machines | undefined;
  authenticateOperator?: OperatorAuthenticator | undefined;
}) {
  const app = new Hono();
  app.get("/v1/machines/access-refusals", async (context) => {
    if (!options.authenticateOperator)
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!(await options.authenticateOperator(context.req.raw)))
      return context.json({ error: "operator_authentication_required" }, 401);
    if (!options.machines) return context.json({ error: "machines_unavailable" }, 503);
    return context.json(await options.machines.accessRefusals());
  });
  app.patch("/v1/machines/:id/access", bodyLimit({ maxSize: 4096 }), async (context) => {
    if (!options.authenticateOperator)
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    const operator = await options.authenticateOperator(context.req.raw);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!options.machines) return context.json({ error: "machines_unavailable" }, 503);
    try {
      return context.json(
        await options.machines.setAccess(context.req.param("id"), await context.req.json()),
      );
    } catch (error) {
      return context.json({ error: "invalid_machine_access", detail: String(error) }, 400);
    }
  });
  return app;
}
