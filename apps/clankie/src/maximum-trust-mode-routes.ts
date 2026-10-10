import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  MAXIMUM_TRUST_MODE_PATH,
  UpdateMaximumTrustModeSchema,
  type MaximumTrustModeSnapshot,
  type MaximumTrustSeat,
} from "@clankie/protocol/owner-settings";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";
import { logger } from "./app/log.ts";

/**
 * Maximum trust mode (VUH-2048): the owner's one switch over the guardrails of
 * every harness Clankie launches next. Owner routes only; no worker, peer,
 * room or tool reaches it.
 */
export function createMaximumTrustModeRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  /** This machine's live seats and the mode each launched with; absent or failing omits the list. */
  liveSeats?: () => Promise<readonly MaximumTrustSeat[]>,
): Hono {
  const app = new Hono();
  const snapshot = async (current: ClankieSettings): Promise<MaximumTrustModeSnapshot> => {
    const enabled = current.maximumTrustMode;
    const seats = await liveSeats?.().catch((error: unknown) => {
      logger.warn(
        { event: "maximum_trust_mode.seats_unavailable", err: error },
        "Live seat modes unavailable",
      );
      return undefined;
    });
    return {
      schemaVersion: 1,
      enabled,
      ...(seats === undefined
        ? {}
        : { seatsOnOtherMode: seats.filter((seat) => seat.maximumTrust !== enabled).slice(0, 256) }),
    };
  };
  app.use(MAXIMUM_TRUST_MODE_PATH, async (context, next) => {
    context.header("cache-control", "no-store");
    const allowed = await authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    await next();
  });
  app.get(MAXIMUM_TRUST_MODE_PATH, async (context) => context.json(await snapshot(await settings.load())));
  app.post(MAXIMUM_TRUST_MODE_PATH, bodyLimit({ maxSize: 256 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateMaximumTrustModeSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    let updated: ClankieSettings;
    try {
      updated = await settings.update(
        (current) => ({ ...current, maximumTrustMode: input.data.enabled }),
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
        },
      );
    } catch {
      return context.json({ error: "maximum_trust_mode_conflict" }, 409);
    }
    logger.warn(
      { event: "maximum_trust_mode.changed", enabled: updated.maximumTrustMode },
      "Maximum trust mode changed",
    );
    return context.json(await snapshot(updated));
  });
  return app;
}
