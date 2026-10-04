import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { FLEET_PROJECT_MEMBERSHIP_PATH, ReadFleetProjectMembershipSchema } from "@clankie/protocol/projects";
import {
  FleetMembershipReadError,
  type FleetProjectMembership,
  type MembershipAuthorization,
} from "./fleet-project-membership.ts";

export function createFleetProjectMembershipRoutes(
  service: Pick<FleetProjectMembership, "read"> | undefined,
  authorize: (request: Request) => Promise<MembershipAuthorization>,
): Hono {
  const app = new Hono();
  app.use(FLEET_PROJECT_MEMBERSHIP_PATH, async (context, next) => {
    context.header("cache-control", "no-store");
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    await next();
  });
  app.post(FLEET_PROJECT_MEMBERSHIP_PATH, bodyLimit({ maxSize: 8 * 1024 }), async (context) => {
    const input = ReadFleetProjectMembershipSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_membership_read" }, 400);
    if (!service) return context.json({ error: "membership_unavailable" }, 503);
    try {
      return context.json(
        await service.read(input.data, context.req.raw.signal, () => authorize(context.req.raw)),
      );
    } catch (error) {
      const code = error instanceof FleetMembershipReadError ? error.code : "unavailable";
      const status =
        code === "forbidden"
          ? 403
          : code === "authentication_required"
            ? 401
            : code === "changed"
              ? 409
              : 503;
      return context.json({ error: `membership_${code}` }, status);
    }
  });
  return app;
}
