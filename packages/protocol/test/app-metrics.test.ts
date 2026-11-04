import { describe, expect, it } from "vitest";
import {
  AppMetricDestinationSchema,
  AppMetricsReportSchema,
  AppMetricsSnapshotSchema,
  type AppMetricsReport,
} from "../src/index.ts";

describe("app navigation metrics public contract", () => {
  it("accepts Feed and keeps every previous destination for older clients", () => {
    expect(AppMetricDestinationSchema.options).toEqual([
      "world",
      "messages",
      "feed",
      "work",
      "terminal",
      "settings",
      "search",
      "mailbox",
      "usage",
    ]);
    for (const destination of AppMetricDestinationSchema.options) {
      const report: AppMetricsReport = {
        platform: "ios",
        summaries: [
          { destination, count: 1, firstFrameMs: { p50: 20, p95: 20 }, longTaskMs: null, slowCount: 0 },
        ],
      };
      expect(AppMetricsReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
      const snapshot = { devices: [{ deviceId: "paired-device", ...report }] };
      expect(AppMetricsSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    }
  });
});
