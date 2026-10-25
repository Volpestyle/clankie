import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  CAPTAIN_SEAT_PATH,
  CAPTAIN_SEAT_START_PATH,
  CAPTAIN_SEAT_STATUS_PATH,
  UpdateCaptainSeatSchema,
  StartCaptainSeatSchema,
  CaptainSeatStatusRequestSchema,
} from "@clankie/protocol/captain-seat";
import type { SettingsStore } from "@clankie/settings";
import { readJson } from "./app/http-auth.ts";
import { CaptainSeats, captainSeatSnapshot } from "./captain-seat.ts";

export function createCaptainSeatRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  seats: CaptainSeats | undefined,
): Hono {
  const app = new Hono();
  app.onError((_error, context) => context.json({ error: "seat_unavailable" }, 503));
  for (const path of [CAPTAIN_SEAT_PATH, CAPTAIN_SEAT_START_PATH, CAPTAIN_SEAT_STATUS_PATH]) {
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      const allowed = await authorize(context.req.raw);
      if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
      await next();
    });
    app.use(path, bodyLimit({ maxSize: 4096 }));
  }
  const snapshot = async () => captainSeatSnapshot(await settings.load(), seats?.supported === true);
  app.get(CAPTAIN_SEAT_PATH, async (context) => context.json(await snapshot()));
  app.post(CAPTAIN_SEAT_PATH, async (context) => {
    if (!seats?.supported) return context.json({ error: "seat_unsupported" }, 403);
    if (!settings.update) return context.json({ error: "seat_unavailable" }, 503);
    const input = UpdateCaptainSeatSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          if (captainSeatSnapshot(current, true).revision !== input.data.expectedRevision)
            throw Error("conflict");
          before = JSON.stringify(current);
          return { ...current, captain: { ...current.captain, seat: input.data.seat } };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true || JSON.stringify(await settings.load()) !== before)
            throw Error("conflict");
        },
      );
      return context.json(captainSeatSnapshot(updated, true));
    } catch {
      return context.json({ error: "seat_conflict" }, 409);
    }
  });
  app.post(CAPTAIN_SEAT_START_PATH, async (context) => {
    if (!seats?.supported) return context.json({ error: "seat_unsupported" }, 403);
    const input = StartCaptainSeatSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    try {
      const result = await seats.start(input.data, async () => (await authorize(context.req.raw)) === true);
      return context.json(result, result.outcome === "starting" ? 202 : 200);
    } catch (error) {
      if (error instanceof Error && error.message === "seat_conflict")
        return context.json({ error: "seat_conflict" }, 409);
      if (error instanceof Error && error.message === "forbidden")
        return context.json({ error: "forbidden" }, 403);
      throw error;
    }
  });
  app.post(CAPTAIN_SEAT_STATUS_PATH, async (context) => {
    if (!seats?.supported) return context.json({ error: "seat_unsupported" }, 403);
    const input = CaptainSeatStatusRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    const result = await seats.status(input.data.requestId);
    return result ? context.json(result) : context.json({ error: "seat_start_not_found" }, 404);
  });
  return app;
}
