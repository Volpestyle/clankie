import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  FLEET_HIRE_DEFAULTS_PATH,
  FLEET_SETTINGS_PATH,
  FLEET_SETTINGS_CONTEXT_PATH,
  HIRE_NO_PREFERENCE,
  HireProfileSchema,
  UpdateFleetHireDefaultsSchema,
  type FleetHireDefaultsSnapshot,
  FleetSettingsContextRequestSchema,
  FleetAutonomySchema,
  UpdateFleetSettingsSchema,
  type FleetSettingsSnapshot,
  type FleetResourcePolicy,
} from "@clankie/protocol";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";
import {
  resolveFleetSettingsContext,
  type FleetSettingsContextDependencies,
} from "./fleet-settings-context.ts";

function fleetSettingsSnapshot(settings: ClankieSettings): FleetSettingsSnapshot {
  const fleet = {
    ...settings.fleet,
    size: settings.fleet.size,
    models: settings.fleet.models,
    ...(settings.fleet.resources === undefined ? {} : { resources: settings.fleet.resources }),
    ...settings.autonomy.fleet,
  };
  return {
    schemaVersion: 1,
    workingPreferences: true,
    fleetGates: true,
    revision: createHash("sha256").update(JSON.stringify(fleet)).digest("hex"),
    fleet,
  };
}
class InvalidHireDefaults extends Error {}
/** Harness, model and effort only; the revision covers the whole stored profile. */
function fleetHireDefaultsSnapshot(settings: ClankieSettings): FleetHireDefaultsSnapshot {
  const hire = settings.fleet.hire ?? {};
  return {
    schemaVersion: 1,
    revision: createHash("sha256").update(JSON.stringify(hire)).digest("hex"),
    hire: {
      ...(hire.harness === undefined ? {} : { harness: hire.harness }),
      ...(hire.model === undefined ? {} : { model: hire.model }),
      ...(hire.effort === undefined ? {} : { effort: hire.effort }),
    },
  };
}
export function createFleetSettingsRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  dependencies: FleetSettingsContextDependencies & {
    configureResources?: ((policy: FleetResourcePolicy) => Promise<unknown>) | undefined;
  } = {},
): Hono {
  const app = new Hono();
  for (const path of [FLEET_SETTINGS_PATH, FLEET_SETTINGS_CONTEXT_PATH, FLEET_HIRE_DEFAULTS_PATH])
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
          const { size, models, resources, notes, tools, peerMessages, hire, ...preferences } =
            input.data.changes;
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
              ...(resources === undefined ? {} : { resources }),
              ...(notes === undefined ? {} : { notes }),
              ...(tools === undefined ? {} : { tools }),
              ...(peerMessages === undefined ? {} : { peerMessages }),
              ...(hire === undefined ? {} : { hire: hire ?? undefined }),
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
      if (input.data.changes.resources !== undefined)
        await dependencies.configureResources?.(input.data.changes.resources);
      return context.json(fleetSettingsSnapshot(updated));
    } catch {
      return context.json({ error: "fleet_settings_conflict" }, 409);
    }
  });
  app.get(FLEET_HIRE_DEFAULTS_PATH, async (context) => {
    const current = await settings.load();
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    return context.json(fleetHireDefaultsSnapshot(current));
  });
  app.post(FLEET_HIRE_DEFAULTS_PATH, bodyLimit({ maxSize: 4 * 1024 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateFleetHireDefaultsSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          if (fleetHireDefaultsSnapshot(current).revision !== input.data.expectedRevision)
            throw new Error("Hire defaults changed");
          before = JSON.stringify(current);
          // `auto` is no preference: the field is cleared, never stored (ea54ebd6).
          const next: Record<string, unknown> = { ...current.fleet.hire };
          for (const [field, value] of Object.entries(input.data.changes)) {
            if (value === undefined) continue;
            if (value === HIRE_NO_PREFERENCE) delete next[field];
            else next[field] = value;
          }
          const parsedHire = HireProfileSchema.safeParse(next);
          if (!parsedHire.success) throw new InvalidHireDefaults();
          const hire = parsedHire.data;
          const fleet = { ...current.fleet };
          if (Object.keys(hire).length) fleet.hire = hire;
          else delete fleet.hire;
          return { ...current, fleet };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      return context.json(fleetHireDefaultsSnapshot(updated));
    } catch (error) {
      if (error instanceof InvalidHireDefaults) return context.json({ error: "malformed" }, 400);
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
