import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  CloseHuddleSchema,
  HUDDLE_CLOSE_PATH,
  HUDDLES_PATH,
  StartHuddleSchema,
  type HuddleList,
} from "@clankie/protocol/huddles";
import type { HuddleService } from "./captain/port.ts";

/**
 * Huddles over HTTP (VUH-2025), the one API the TUI, app, web, desktop and
 * dashboard share. Owner or Take Control authority, as the fleet roster.
 */
export function createHuddleRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  huddles: HuddleService | undefined,
): Hono {
  const app = new Hono();
  const gate: MiddlewareHandler = async (context, next) => {
    context.header("cache-control", "no-store");
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    if (!huddles) return context.json({ error: "huddles_unavailable" }, 503);
    await next();
  };
  app.use(HUDDLES_PATH, gate);
  app.use(HUDDLE_CLOSE_PATH, gate);
  app.get(HUDDLES_PATH, (context) => {
    const body: HuddleList = { schemaVersion: 1, huddles: [...huddles!.list()] };
    return context.json(body);
  });
  app.post(HUDDLES_PATH, bodyLimit({ maxSize: 4096 }), async (context) => {
    const input = StartHuddleSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!input.success) return context.json({ error: "invalid_huddle" }, 400);
    try {
      return context.json(await huddles!.start(input.data), 201);
    } catch (error) {
      // The reason is the message every surface shows (an unknown project, an unreadable fleet).
      return context.json({ error: error instanceof Error ? error.message : "Huddle unavailable" }, 422);
    }
  });
  app.post(HUDDLE_CLOSE_PATH, bodyLimit({ maxSize: 1024 }), async (context) => {
    const input = CloseHuddleSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!input.success) return context.json({ error: "invalid_huddle" }, 400);
    const huddle = await huddles!.close(input.data.id);
    return huddle ? context.json(huddle) : context.json({ error: "unknown_huddle" }, 404);
  });
  return app;
}
