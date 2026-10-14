import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  EVIDENCE_STORAGE_SETTINGS_PATH,
  EvidenceSettingsSchema,
  UpdateEvidenceStorageSchema,
  type EvidenceStorageSnapshot,
} from "@clankie/protocol/owner-settings";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";
import type { EvidenceStore } from "./evidence-store.ts";

/** Configuration only: the captured adapter and private historical destinations never change here. */
export function createEvidenceStorageSettingsRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  store: EvidenceStore | undefined,
): Hono {
  const app = new Hono();
  const loadValidated = async () => settings.load().catch(() => undefined);
  const snapshot = (current: ClankieSettings): EvidenceStorageSnapshot => {
    if (!store) throw new Error("evidence_unavailable");
    const configured = EvidenceSettingsSchema.parse(current.evidence);
    const active = EvidenceSettingsSchema.parse(store.storage.activeDestination);
    return {
      schemaVersion: 1,
      revision: createHash("sha256").update(JSON.stringify(current)).digest("hex"),
      configured,
      active,
      restartRequired: JSON.stringify(configured) !== JSON.stringify(active),
    };
  };
  app.use(EVIDENCE_STORAGE_SETTINGS_PATH, async (context, next) => {
    context.header("cache-control", "no-store");
    const allowed = await authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    if (!store) return context.json({ error: "evidence_unavailable" }, 503);
    await next();
  });
  app.get(EVIDENCE_STORAGE_SETTINGS_PATH, async (context) => {
    const current = await loadValidated();
    if (!current) return context.json({ error: "evidence_settings_invalid" }, 503);
    const result = snapshot(current);
    const allowed = await authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    const latest = await loadValidated();
    if (!latest) return context.json({ error: "evidence_settings_invalid" }, 503);
    if (JSON.stringify(latest) !== JSON.stringify(current))
      return context.json({ error: "evidence_settings_conflict" }, 409);
    return context.json(result);
  });
  app.post(EVIDENCE_STORAGE_SETTINGS_PATH, bodyLimit({ maxSize: 2048 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateEvidenceStorageSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    if (!(await loadValidated())) return context.json({ error: "evidence_settings_invalid" }, 503);
    let before: string | undefined;
    let updated: ClankieSettings;
    try {
      updated = await settings.update(
        (current) => {
          if (snapshot(current).revision !== input.data.expectedRevision) throw new Error("Settings changed");
          before = JSON.stringify(current);
          return { ...current, evidence: input.data.configured };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true || JSON.stringify(await settings.load()) !== before)
            throw new Error("Settings changed");
        },
      );
    } catch {
      return context.json({ error: "evidence_settings_conflict" }, 409);
    }
    const allowed = await authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    const latest = await loadValidated();
    if (!latest) return context.json({ error: "evidence_settings_invalid" }, 503);
    if (JSON.stringify(latest) !== JSON.stringify(updated))
      return context.json({ error: "evidence_settings_conflict" }, 409);
    return context.json(snapshot(updated));
  });
  return app;
}
