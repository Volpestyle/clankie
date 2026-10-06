import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  FLEET_RESOURCES_PATH,
  FLEET_SIMULATORS_PATH,
  FleetResourceSnapshotSchema,
  FleetSimulatorRequestSchema,
  FleetSimulatorResultSchema,
  FleetSimulatorStatusSchema,
} from "@clankie/protocol";
import type { FleetResourceRuntime } from "./fleet-resource-runtime.ts";

/** Resource metadata and simulator control remain behind current owner authority. */
export function createFleetResourceRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  resources?: FleetResourceRuntime,
): Hono {
  const app = new Hono();
  for (const path of [FLEET_RESOURCES_PATH, FLEET_SIMULATORS_PATH])
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      const authority = await authorize(context.req.raw);
      if (authority !== true)
        return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
      if (!resources) return context.json({ error: "fleet_resources_unavailable" }, 503);
      await next();
    });
  app.get(FLEET_RESOURCES_PATH, async (context) => {
    const snapshot = resources!.status();
    if (!snapshot) return context.json({ error: "fleet_resources_unavailable" }, 503);
    if ((await authorize(context.req.raw)) !== true) return context.json({ error: "forbidden" }, 403);
    return context.json(FleetResourceSnapshotSchema.parse(snapshot));
  });
  app.get(FLEET_SIMULATORS_PATH, async (context) => {
    const snapshot = await resources!.simulators.snapshot();
    if ((await authorize(context.req.raw)) !== true) return context.json({ error: "forbidden" }, 403);
    return context.json(FleetSimulatorStatusSchema.parse({ schemaVersion: 1, ...snapshot }));
  });
  app.post(FLEET_SIMULATORS_PATH, bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    const input = FleetSimulatorRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed_simulator_request" }, 400);
    const request = input.data;
    const allowed = async () =>
      !context.req.raw.signal.aborted && (await authorize(context.req.raw)) === true;
    try {
      const owner = await resources!.proveSimulatorSeat({
        seatId: request.seatId,
        ...(request.fleet === undefined ? {} : { fleet: request.fleet }),
      });
      if (!(await allowed())) return context.json({ error: "forbidden" }, 403);
      const options = { authorize: allowed, signal: context.req.raw.signal };
      const result =
        request.action === "acquire"
          ? await resources!.simulators.acquire({
              seatId: owner.seatId,
              occupantId: owner.occupantId,
              ...(owner.fleet === undefined ? {} : { fleet: owner.fleet }),
              deviceType: request.deviceType,
              runtime: request.runtime,
              ...options,
            })
          : request.action === "touch"
            ? await resources!.simulators.touch(request.id, owner, options)
            : await resources!.simulators.release(request.id, owner, options);
      return context.json(
        FleetSimulatorResultSchema.parse(result),
        result.outcome === "rejected" ? 409 : 200,
      );
    } catch {
      return context.json({ outcome: "rejected", reason: "owner_unavailable" }, 409);
    }
  });
  return app;
}
