import { readJson } from "./app/http-auth.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  DESKTOP_ACCESS_PATH,
  REFRESH_DESKTOP_PERMISSIONS_PATH,
  RefreshDesktopPermissionsSchema,
  DesktopPermissionCheckSchema,
  type DesktopPermissionCheck,
  isDesktopAccessRoute,
  DesktopMachineIdSchema,
  DesktopLeadIdSchema,
  PublishDesktopPermissionsSchema,
  UpdateDesktopModeSchema,
} from "@clankie/protocol/desktop-access";
import type { DesktopAccess } from "./desktop-access.ts";

type Authorize = (request: Request) => Promise<true | "authentication_required" | "forbidden">;

/** No worker, captain, joined-host or room bearer may configure desktop use. */
export function createDesktopAccessRoutes(options: {
  desktop: DesktopAccess;
  read: Authorize;
  write: Authorize;
  /** Publishing a probe is local operator-only, never a phone/app assertion. */
  publish: Authorize;
  check?: (guard: () => Promise<void>) => Promise<DesktopPermissionCheck>;
  known: (id: string) => Promise<boolean>;
}): Hono {
  const app = new Hono();
  const authorizeRoute = async (context: import("hono").Context, next: import("hono").Next) => {
    context.header("cache-control", "no-store");
    if (context.req.method === "POST" && new URL(context.req.url).search)
      return context.json({ error: "malformed" }, 400);
    const authorize =
      context.req.method === "GET"
        ? options.read
        : context.req.path.endsWith("/permissions")
          ? options.publish
          : options.write;
    const allowed = await authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    await next();
  };
  app.use(DESKTOP_ACCESS_PATH, authorizeRoute);
  app.use(`${DESKTOP_ACCESS_PATH}/permissions`, authorizeRoute);
  app.use(REFRESH_DESKTOP_PERMISSIONS_PATH, authorizeRoute);
  const machine = async (raw: string) =>
    DesktopMachineIdSchema.safeParse(raw).success && (await options.known(raw));
  app.get(DESKTOP_ACCESS_PATH, async (context) => {
    if (!isDesktopAccessRoute(new URL(context.req.url).pathname + new URL(context.req.url).search))
      return context.json({ error: "malformed" }, 400);
    const id = context.req.query("machine") ?? "local";
    if (!(await machine(id))) return context.json({ error: "unknown_machine" }, 404);
    const lead = context.req.query("lead");
    if (lead !== undefined && !DesktopLeadIdSchema.safeParse(lead).success)
      return context.json({ error: "malformed" }, 400);
    const state = await options.desktop.read(id, lead);
    const allowed = await options.read(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    return context.json(state);
  });
  app.post(DESKTOP_ACCESS_PATH, bodyLimit({ maxSize: 2048 }), async (context) => {
    const input = UpdateDesktopModeSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    const id = input.data.machineId;
    if (!(await machine(id))) return context.json({ error: "unknown_machine" }, 404);
    try {
      return context.json(
        await options.desktop.set(
          id,
          input.data,
          async () => {
            if ((await options.write(context.req.raw)) !== true) throw Error("desktop_owner_revoked");
          },
          async () => {
            if (!(await options.known(id))) throw Error("unknown_machine");
          },
        ),
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "desktop_mode_conflict";
      return context.json(
        {
          error: ["desktop_mode_above_ceiling", "desktop_owner_revoked", "unknown_machine"].includes(code)
            ? code
            : "desktop_mode_conflict",
        },
        code === "desktop_mode_above_ceiling" || code === "desktop_owner_revoked" ? 403 : 409,
      );
    }
  });
  app.post(REFRESH_DESKTOP_PERMISSIONS_PATH, bodyLimit({ maxSize: 2048 }), async (context) => {
    if (!RefreshDesktopPermissionsSchema.safeParse(await readJson(context.req.raw)).success)
      return context.json({ error: "malformed" }, 400);
    const guard = async () => {
      context.req.raw.signal.throwIfAborted();
      if ((await options.write(context.req.raw)) !== true) throw Error("desktop_owner_revoked");
    };
    try {
      const result = DesktopPermissionCheckSchema.parse(
        options.check ? await options.check(guard) : { state: "unavailable", reason: "terminal_unavailable" },
      );
      // Native cleanup and all asynchronous preparation complete before the final
      // shared owner decision. No await between that decision and publication.
      await guard();
      if (result.state === "observed") options.desktop.publish("local", result.observation);
      return context.json(result);
    } catch (error) {
      if (error instanceof Error && error.message === "desktop_owner_revoked")
        return context.json({ error: "desktop_owner_revoked" }, 403);
      return context.json({ state: "unavailable", reason: "invalid_observation" });
    }
  });
  app.post(`${DESKTOP_ACCESS_PATH}/permissions`, bodyLimit({ maxSize: 2048 }), async (context) => {
    const id = "local";
    const input = PublishDesktopPermissionsSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: "malformed" }, 400);

    const allowed = await options.publish(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    try {
      options.desktop.publish(id, input.data.observation);
    } catch {
      return context.json({ error: "desktop_actor_observation_stale" }, 400);
    }
    return context.json(await options.desktop.read(id));
  });
  return app;
}
