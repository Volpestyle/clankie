import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  MACHINE_JOIN_START_PATH,
  MACHINE_JOIN_STATUS_PATH,
  MACHINE_JOIN_APPROVE_PATH,
  MACHINE_JOIN_CHALLENGE_PATH,
  MACHINE_JOIN_CHANNEL_PATH,
  MACHINE_JOIN_LEAVE_PATH,
  MachineJoinIdSchema,
} from "@clankie/protocol/machine-join";
import type { MachineJoins } from "./machine-joins.ts";

/** The body owns consent. The gateway may route bootstrap/machine traffic, never approve it. */
export function createMachineJoinRoutes(
  joins: MachineJoins | undefined,
  authorizeOwner: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
): Hono {
  const app = new Hono();
  const paths = [
    "/v1/machine-joins/settings",
    MACHINE_JOIN_START_PATH,
    MACHINE_JOIN_STATUS_PATH,
    MACHINE_JOIN_APPROVE_PATH,
    MACHINE_JOIN_CHALLENGE_PATH,
    MACHINE_JOIN_CHANNEL_PATH,
    MACHINE_JOIN_LEAVE_PATH,
  ];
  for (const path of paths)
    app.use(
      path,
      bodyLimit({ maxSize: path === MACHINE_JOIN_CHANNEL_PATH ? 2 * 1024 * 1024 : 16 * 1024 }),
      async (context, next) => {
        context.header("cache-control", "no-store");
        await next();
      },
    );
  const bearer = (request: Request) =>
    /^Bearer ([A-Za-z0-9_-]{1,128})$/u.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  app.on(["GET", "PATCH"], "/v1/machine-joins/settings", async (context) => {
    const allowed = await authorizeOwner(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    if (!joins) return context.json({ error: "join_unavailable" }, 503);
    if (context.req.method === "PATCH") {
      let body;
      try {
        body = await context.req.json();
        if (!body || Object.keys(body).length !== 1 || typeof body.enabled !== "boolean")
          throw Error("malformed");
      } catch {
        return context.json({ error: "malformed" }, 400);
      }
      try {
        await joins.setLegacyJoinsEnabled(body.enabled, async () => {
          if ((await authorizeOwner(context.req.raw)) !== true) throw Error("owner_revoked");
        });
      } catch {
        return context.json({ error: "join_settings_conflict" }, 409);
      }
    }
    return context.json({ enabled: await joins.legacyJoinsEnabled() });
  });
  app.post(MACHINE_JOIN_START_PATH, async (context) => {
    if (!joins) return context.json({ error: "join_unavailable" }, 503);
    try {
      const input = await context.req.json();
      if (!(await joins.legacyJoinsEnabled()))
        return context.json(
          {
            error: "legacy_joins_disabled",
            detail:
              "New legacy machine joins are disabled on the home Mac. Enable them with clankie machines legacy-joins on.",
          },
          403,
        );
      return context.json(joins.start(input));
    } catch {
      return context.json({ error: "join_refused" }, 400);
    }
  });
  app.post(MACHINE_JOIN_STATUS_PATH, async (context) => {
    if (!joins) return context.json({ error: "join_unavailable" }, 503);
    try {
      const body = await context.req.json();
      const id = MachineJoinIdSchema.parse(body.joinId);
      if (Object.keys(body).length !== 1) throw Error("malformed");
      return context.json(joins.status(id, bearer(context.req.raw)));
    } catch {
      return context.json({ error: "malformed" }, 400);
    }
  });
  app.post(MACHINE_JOIN_APPROVE_PATH, async (context) => {
    const allowed = await authorizeOwner(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    if (!joins) return context.json({ error: "join_unavailable" }, 503);
    try {
      return context.json(
        await joins.approve(await context.req.json(), async () => {
          if ((await authorizeOwner(context.req.raw)) !== true) throw Error("owner_revoked");
        }),
      );
    } catch {
      return context.json({ error: "join_refused" }, 400);
    }
  });
  app.post(MACHINE_JOIN_CHALLENGE_PATH, async (context) => {
    if (!joins) return context.json({ error: "join_unavailable" }, 503);
    try {
      const body = await context.req.json();
      if (Object.keys(body).length !== 1) throw Error("malformed");
      return context.json(await joins.challenge(body.machineId));
    } catch (error) {
      if (error instanceof Error && error.message === "revoked")
        return context.json({ error: "revoked" }, 403);
      return context.json({ error: "join_challenge_unavailable" }, 503);
    }
  });
  app.post(MACHINE_JOIN_CHANNEL_PATH, async (context) => {
    if (!joins) return context.json({ error: "join_unavailable" }, 503);
    try {
      return context.json(await joins.exchange(await context.req.json(), "poll"));
    } catch (error) {
      if (error instanceof Error && error.message === "revoked")
        return context.json({ error: "revoked" }, 403);
      return context.json({ error: "invalid_machine_request" }, 403);
    }
  });
  app.post(MACHINE_JOIN_LEAVE_PATH, async (context) => {
    if (!joins) return context.json({ error: "join_unavailable" }, 503);
    try {
      return context.json(await joins.exchange(await context.req.json(), "leave"));
    } catch (error) {
      if (error instanceof Error && error.message === "revoked")
        return context.json({ error: "revoked" }, 403);
      return context.json({ error: "join_leave_unconfirmed" }, 503);
    }
  });
  return app;
}
