import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  RUNTIME_HEALTH_PATH,
  RuntimeHealthObservationSchema,
  UpdateRuntimeHealthSchema,
  RuntimeHealthSettingsSchema,
  type RuntimeHealthObservation,
  type RuntimeHealthSnapshot,
} from "@clankie/protocol";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";

function runtimeHealthSnapshot(
  settings: ClankieSettings,
  observation: RuntimeHealthObservation,
): RuntimeHealthSnapshot {
  return {
    schemaVersion: 1,
    settings: settings.runtimeHealth,
    revision: createHash("sha256").update(JSON.stringify(settings.runtimeHealth)).digest("hex"),
    observation: RuntimeHealthObservationSchema.parse(observation),
  };
}
export function createRuntimeHealthRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  observation: () => RuntimeHealthObservation,
): Hono {
  const app = new Hono();
  app.use(RUNTIME_HEALTH_PATH, async (context, next) => {
    context.header("cache-control", "no-store");
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    await next();
  });
  app.get(RUNTIME_HEALTH_PATH, async (context) => {
    const current = await settings.load();
    if ((await authorize(context.req.raw)) !== true) return context.json({ error: "forbidden" }, 403);
    return context.json(runtimeHealthSnapshot(current, observation()));
  });
  app.post(RUNTIME_HEALTH_PATH, bodyLimit({ maxSize: 4096 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateRuntimeHealthSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          if (runtimeHealthSnapshot(current, observation()).revision !== input.data.expectedRevision)
            throw new Error("Runtime health settings changed");
          before = JSON.stringify(current);
          return {
            ...current,
            runtimeHealth: RuntimeHealthSettingsSchema.parse({
              ...current.runtimeHealth,
              ...input.data.changes,
            }),
          };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      return context.json(runtimeHealthSnapshot(updated, observation()));
    } catch {
      return context.json({ error: "runtime_health_conflict" }, 409);
    }
  });
  return app;
}
