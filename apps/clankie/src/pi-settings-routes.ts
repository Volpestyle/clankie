import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PI_SETTINGS_PATH, UpdatePiSettingsSchema } from "@clankie/protocol/worker-accounts";
import type { ClankieAppDependencies } from "./app/types.ts";

export function createPiSettingsRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: NonNullable<ClankieAppDependencies["settings"]>,
): Hono {
  const app = new Hono();
  const snapshot = (current: Awaited<ReturnType<typeof settings.load>>) => ({
    revision: createHash("sha256")
      .update(JSON.stringify(current.piNativeEnabled ?? null))
      .digest("hex"),
    enabled: current.piNativeEnabled ?? process.env.CLANKIE_PI_NATIVE_ENABLED?.trim() === "1",
  });
  app.use(PI_SETTINGS_PATH, async (context, next) => {
    context.header("cache-control", "no-store");
    const allowed = await authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    await next();
  });
  app.get(PI_SETTINGS_PATH, async (context) => {
    const current = await settings.load();
    const allowed = await authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    return context.json(snapshot(current));
  });
  app.post(PI_SETTINGS_PATH, bodyLimit({ maxSize: 20_000 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const parsed = UpdatePiSettingsSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          if (snapshot(current).revision !== parsed.data.expectedRevision) throw Error("Settings changed");
          before = JSON.stringify(current);
          return { ...current, piNativeEnabled: parsed.data.enabled };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true || JSON.stringify(await settings.load()) !== before)
            throw Error("Owner settings changed");
        },
      );
      return context.json(snapshot(updated));
    } catch {
      return context.json({ error: "pi_settings_conflict" }, 409);
    }
  });
  return app;
}
