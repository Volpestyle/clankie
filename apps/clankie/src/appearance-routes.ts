import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  APPEARANCE_SETTINGS_PATH,
  UpdateAppearanceSettingsSchema,
  type AppearanceSettingsSnapshot,
} from "@clankie/protocol/owner-settings";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";

/**
 * Clankie's look, read and changed through one revision-fenced owner document
 * (ADR 0248) so every surface shows the same choice.
 */
export function createAppearanceRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
): Hono {
  const app = new Hono();
  const snapshot = (current: ClankieSettings): AppearanceSettingsSnapshot => {
    const appearance = { leadSkin: current.appearance.leadSkin };
    return {
      schemaVersion: 1,
      revision: createHash("sha256").update(JSON.stringify(appearance)).digest("hex"),
      appearance,
    };
  };
  app.use(APPEARANCE_SETTINGS_PATH, async (context, next) => {
    context.header("cache-control", "no-store");
    const allowed = await authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    await next();
  });
  app.get(APPEARANCE_SETTINGS_PATH, async (context) => context.json(snapshot(await settings.load())));
  app.post(APPEARANCE_SETTINGS_PATH, bodyLimit({ maxSize: 1024 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateAppearanceSettingsSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    let before: string | undefined;
    let updated: ClankieSettings;
    try {
      updated = await settings.update(
        (current) => {
          if (snapshot(current).revision !== input.data.expectedRevision)
            throw new Error("Appearance changed");
          before = JSON.stringify(current);
          return {
            ...current,
            appearance: { leadSkin: input.data.changes.leadSkin ?? current.appearance.leadSkin },
          };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true || JSON.stringify(await settings.load()) !== before)
            throw new Error("Owner settings changed");
        },
      );
    } catch {
      return context.json({ error: "appearance_conflict" }, 409);
    }
    return context.json(snapshot(updated));
  });
  return app;
}
