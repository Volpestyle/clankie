import {
  APP_METRICS_BODY_BYTES_MAX,
  APP_METRICS_DEVICE_PLATFORM_LIMIT,
  APP_METRICS_PATH,
  APP_METRICS_POST_PATH,
  AppMetricsReportSchema,
  type AppMetricsReport,
  type AppMetricsSnapshot,
} from "@clankie/protocol/app-metrics";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticateOperator, readJson } from "./http-auth.ts";
import type { ClankieAppDependencies, DeviceAuthDenial, TrustedDeviceIdentity } from "./types.ts";

const MAX_AGE_MS = 60 * 60_000;
/** Per-service ephemeral rolling windows, not a durable activity or device history. */
export function registerAppMetricsRoutes(
  app: Hono,
  options: {
    dependencies: Pick<ClankieAppDependencies, "authenticateOperator">;
    authenticateDevice(request: Request): Promise<TrustedDeviceIdentity | "unavailable" | DeviceAuthDenial>;
    active(deviceId: string): boolean;
    now(): number;
  },
) {
  const rows = new Map<string, { deviceId: string; report: AppMetricsReport; at: number }>();
  const prune = () => {
    const now = options.now();
    for (const [key, row] of rows)
      if (now - row.at >= MAX_AGE_MS || !options.active(row.deviceId)) rows.delete(key);
  };
  app.post(APP_METRICS_POST_PATH, bodyLimit({ maxSize: APP_METRICS_BODY_BYTES_MAX }), async (context) => {
    context.header("cache-control", "no-store");
    const device = await options.authenticateDevice(context.req.raw);
    if (device === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
    if ("denied" in device) return context.json({ error: "device_authentication_required" }, 401);
    const parsed = AppMetricsReportSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_app_metrics" }, 400);
    prune();
    const key = `${device.deviceId}:${parsed.data.platform}`;
    const previous = rows.get(key);
    if (previous && options.now() - previous.at < 1_000) {
      return context.json({ error: "app_metrics_throttled" }, 429, { "retry-after": "1" });
    }
    // A complete app-computed last-64 snapshot replaces its predecessor; never average percentiles.
    rows.delete(key);
    rows.set(key, { deviceId: device.deviceId, report: parsed.data, at: options.now() });
    while (rows.size > APP_METRICS_DEVICE_PLATFORM_LIMIT) rows.delete(rows.keys().next().value!);
    return context.json({ accepted: parsed.data.summaries.length }, 202);
  });
  app.get(APP_METRICS_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const operator = await authenticateOperator(context.req.raw, options.dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    prune();
    const snapshot: AppMetricsSnapshot = {
      devices: [...rows.values()].map((row) => ({ deviceId: row.deviceId, ...row.report })),
    };
    return context.json(snapshot);
  });
}
