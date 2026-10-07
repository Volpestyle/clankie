import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  HOST_SETTINGS_PATH,
  UpdateHostSettingsSchema,
  type HostSettingsSnapshot,
} from "@clankie/protocol/owner-settings";
import type { HostPowerReport } from "@clankie/protocol/host-power";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";

export function createHostSettingsRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  options: {
    platform?: NodeJS.Platform;
    autoUpdateManaged?: boolean;
    applyKeepAwake?: () => Promise<void>;
    power?: () => HostPowerReport;
    keepAwakeStatus?: () => Promise<NonNullable<HostSettingsSnapshot["keepAwakeService"]>>;
  } = {},
): Hono {
  const app = new Hono();
  const managed = options.autoUpdateManaged === true;
  const supported = !managed && (options.platform ?? process.platform) === "darwin";
  const snapshot = (current: ClankieSettings): HostSettingsSnapshot => {
    const host = { keepAwake: current.host.keepAwake, autoUpdate: current.host.autoUpdate };
    const power = options.power?.();
    return {
      schemaVersion: 1,
      revision: createHash("sha256").update(JSON.stringify(host)).digest("hex"),
      host,
      keepAwakeSupported: supported,
      autoUpdateManaged: managed,
      autoUpdateEffective: managed || host.autoUpdate,
      ...(power === undefined ? {} : { power: { ...power, keepAwakeRequested: host.keepAwake } }),
    };
  };
  const withStatus = async (current: ClankieSettings) => ({
    ...snapshot(current),
    ...(options.keepAwakeStatus === undefined ? {} : { keepAwakeService: await options.keepAwakeStatus() }),
  });
  app.use(HOST_SETTINGS_PATH, async (context, next) => {
    context.header("cache-control", "no-store");
    const allowed = await authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    await next();
  });
  app.get(HOST_SETTINGS_PATH, async (context) => {
    const current = await settings.load();
    const result = await withStatus(current);
    const allowed = await authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    return context.json(result);
  });
  app.post(HOST_SETTINGS_PATH, bodyLimit({ maxSize: 2048 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateHostSettingsSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    if (input.data.changes.keepAwake === true && !supported)
      return context.json({ error: "keep_awake_unsupported" }, 400);
    if (input.data.changes.autoUpdate === false && managed)
      return context.json({ error: "auto_update_managed" }, 400);
    let before: string | undefined;
    let updated: ClankieSettings;
    try {
      updated = await settings.update(
        (current) => {
          if (snapshot(current).revision !== input.data.expectedRevision)
            throw new Error("Host settings changed");
          before = JSON.stringify(current);
          return {
            ...current,
            host: {
              ...current.host,
              ...(input.data.changes.keepAwake === undefined
                ? {}
                : { keepAwake: input.data.changes.keepAwake }),
              ...(input.data.changes.autoUpdate === undefined
                ? {}
                : { autoUpdate: input.data.changes.autoUpdate }),
            },
          };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true || JSON.stringify(await settings.load()) !== before)
            throw new Error("Owner settings changed");
        },
      );
    } catch {
      return context.json({ error: "host_settings_conflict" }, 409);
    }
    if (input.data.changes.keepAwake !== undefined) {
      try {
        await options.applyKeepAwake?.();
      } catch {
        return context.json(
          { error: "keep_awake_apply_failed", saved: true, settings: await withStatus(updated) },
          503,
        );
      }
    }
    return context.json(await withStatus(updated));
  });
  return app;
}
