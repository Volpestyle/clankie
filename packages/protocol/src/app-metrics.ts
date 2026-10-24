import { z } from "zod";

/** Content-free Release navigation measurements; device identity comes only from authentication. */
export const APP_METRICS_POST_PATH = "/v1/devices/self/app-metrics";
export const APP_METRICS_PATH = "/v1/app/metrics";
export const APP_METRICS_BODY_BYTES_MAX = 4 * 1024;
export const APP_METRICS_SAMPLE_LIMIT = 64;
export const APP_METRICS_DEVICE_PLATFORM_LIMIT = 64;
export const AppMetricDestinationSchema = z.enum([
  "world",
  "messages",
  "work",
  "terminal",
  "settings",
  "search",
  "mailbox",
  "usage",
]);
export type AppMetricDestination = z.infer<typeof AppMetricDestinationSchema>;
const MillisecondsSchema = z.number().finite().nonnegative().max(60_000);
const PercentilesSchema = z
  .object({ p50: MillisecondsSchema, p95: MillisecondsSchema })
  .strict()
  .refine((value) => value.p50 <= value.p95, "p50 must not exceed p95");
export const AppTimingSummarySchema = z
  .object({
    destination: AppMetricDestinationSchema,
    count: z.number().int().min(1).max(APP_METRICS_SAMPLE_LIMIT),
    firstFrameMs: PercentilesSchema,
    /** Unsupported long-task observation is unknown, never a reported zero. */
    longTaskMs: PercentilesSchema.nullable(),
    /** Number of first frames over 100ms in this rolling window; nonzero is the warning flag. */
    slowCount: z.number().int().nonnegative().max(APP_METRICS_SAMPLE_LIMIT),
  })
  .strict()
  .refine((value) => value.slowCount <= value.count, "slow count must not exceed sample count");
export type AppTimingSummary = z.infer<typeof AppTimingSummarySchema>;
const SummariesSchema = z
  .array(AppTimingSummarySchema)
  .min(1)
  .max(8)
  .refine(
    (rows) => new Set(rows.map((row) => row.destination)).size === rows.length,
    "duplicate destination",
  );
export const AppMetricsReportSchema = z
  .object({
    platform: z.enum(["ios", "ipados", "macos", "android", "web"]),
    summaries: SummariesSchema,
  })
  .strict();
export type AppMetricsReport = z.infer<typeof AppMetricsReportSchema>;
export const AppMetricsAcceptedSchema = z.object({ accepted: z.number().int().min(1).max(8) }).strict();
export const AppMetricsSnapshotSchema = z
  .object({
    devices: z
      .array(AppMetricsReportSchema.extend({ deviceId: z.string().min(1).max(128) }).strict())
      .max(APP_METRICS_DEVICE_PLATFORM_LIMIT),
  })
  .strict();
export type AppMetricsSnapshot = z.infer<typeof AppMetricsSnapshotSchema>;
