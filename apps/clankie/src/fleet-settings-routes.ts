import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  FLEET_SETTINGS_PATH,
  FLEET_SETTINGS_CONTEXT_PATH,
  FleetSettingsContextRequestSchema,
  FleetAutonomySchema,
  UpdateFleetSettingsSchema,
  type FleetSettingsSnapshot,
} from "@clankie/protocol";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";
import {
  resolveFleetSettingsContext,
  type FleetSettingsContextDependencies,
} from "./fleet-settings-context.ts";

export function fleetSettingsSnapshot(settings: ClankieSettings): FleetSettingsSnapshot {
  const fleet = { size: settings.fleet.size, models: settings.fleet.models, ...settings.autonomy.fleet };
  return {
    schemaVersion: 1,
    workingPreferences: true,
    revision: createHash("sha256").update(JSON.stringify(fleet)).digest("hex"),
    fleet,
  };
}
export function createFleetSettingsRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  dependencies: FleetSettingsContextDependencies = {},
): Hono {
  const app = new Hono();
  for (const path of [FLEET_SETTINGS_PATH, FLEET_SETTINGS_CONTEXT_PATH])
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      const authority = await authorize(context.req.raw);
      if (authority !== true)
        return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
      await next();
    });
  app.get(FLEET_SETTINGS_PATH, async (context) => {
    const current = await settings.load();
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    return context.json(fleetSettingsSnapshot(current));
  });
  app.post(FLEET_SETTINGS_PATH, bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateFleetSettingsSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          if (fleetSettingsSnapshot(current).revision !== input.data.expectedRevision)
            throw new Error("Fleet settings changed");
          before = JSON.stringify(current);
          const { size, models, ...preferences } = input.data.changes;
          const defaults = FleetAutonomySchema.parse({});
          const resolved = Object.fromEntries(
            Object.entries(preferences).map(([field, value]) => [
              field,
              value ?? defaults[field as keyof typeof defaults],
            ]),
          );
          return {
            ...current,
            fleet: {
              ...current.fleet,
              ...(size === undefined ? {} : { size }),
              ...(models === undefined ? {} : { models }),
            },
            autonomy: {
              ...current.autonomy,
              fleet: FleetAutonomySchema.parse({
                ...current.autonomy.fleet,
                ...resolved,
              }),
            },
          };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      return context.json(fleetSettingsSnapshot(updated));
    } catch {
      return context.json({ error: "fleet_settings_conflict" }, 409);
    }
  });
  app.get(FLEET_SETTINGS_CONTEXT_PATH, async (context) => {
    const input = FleetSettingsContextRequestSchema.safeParse(context.req.query());
    if (!input.success) return context.json({ error: "invalid_fleet_settings_context" }, 400);
    try {
      const current = await settings.load();
      const result = await resolveFleetSettingsContext(current, input.data, dependencies);
      if (JSON.stringify(await settings.load()) !== JSON.stringify(current))
        throw new Error("Settings changed");
      const authority = await authorize(context.req.raw);
      if (authority !== true)
        return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
      return context.json(result);
    } catch (error) {
      return context.json(
        {
          error: "fleet_settings_context_unavailable",
          detail: error instanceof Error ? error.message : "Context unavailable",
        },
        409,
      );
    }
  });
  return app;
}
