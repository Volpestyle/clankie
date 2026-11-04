import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  FOREIGN_HEAVY_PERMITS_PATH,
  UpdateForeignHeavyPermitsSchema,
} from "@clankie/protocol/owner-settings";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";
import { logger } from "./app/log.ts";
import type { ForeignHeavyPermits } from "./foreign-heavy-permits.ts";

/**
 * Foreign heavy permits (#562): the owner's switch for letting one other
 * local account queue for heavy slots. Owner routes only; no worker, peer,
 * room or tool reaches it, and fleet settings never carry it.
 */
export function createForeignHeavyPermitsRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  permits: ForeignHeavyPermits | undefined,
): Hono {
  const app = new Hono();
  app.use(FOREIGN_HEAVY_PERMITS_PATH, async (context, next) => {
    context.header("cache-control", "no-store");
    const allowed = await authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    await next();
  });
  app.get(FOREIGN_HEAVY_PERMITS_PATH, async (context) => {
    if (!permits) return context.json({ error: "fleet_resources_unavailable" }, 503);
    return context.json(permits.snapshot());
  });
  app.post(FOREIGN_HEAVY_PERMITS_PATH, bodyLimit({ maxSize: 512 }), async (context) => {
    if (!permits) return context.json({ error: "fleet_resources_unavailable" }, 503);
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    // allow-swallowed-rejection -- a body that is not JSON is malformed, answered 400 below.
    const input = UpdateForeignHeavyPermitsSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    let updated: ClankieSettings;
    try {
      updated = await settings.update(
        (current) => {
          const { foreignHeavyPermits: _previous, ...rest } = current;
          return input.data.enabled ? { ...rest, foreignHeavyPermits: input.data.settings } : rest;
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
        },
      );
    } catch {
      return context.json({ error: "foreign_heavy_permits_conflict" }, 409);
    }
    logger.warn(
      {
        event: "foreign_permits.changed",
        enabled: updated.foreignHeavyPermits !== undefined,
        ...(updated.foreignHeavyPermits ? { user: updated.foreignHeavyPermits.user } : {}),
      },
      "Foreign heavy permits changed",
    );
    return context.json(await permits.apply(updated.foreignHeavyPermits));
  });
  return app;
}
