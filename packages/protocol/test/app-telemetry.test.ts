import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_TELEMETRY_EVENTS_MAX,
  AppTelemetryBatchSchema,
  type AppTelemetryBatch,
} from "../src/app-telemetry.ts";

const batch = (overrides: Partial<AppTelemetryBatch> = {}): AppTelemetryBatch => ({
  v: 1,
  hostId: "host_abcdefghijklmnop",
  deviceRef: "dv1_abcdefghijklmnopqrstuv",
  platform: "ios",
  appVersion: "2.4.0",
  events: [
    {
      event: "app.reconnect",
      atMs: 1_790_000_000_000,
      outcome: "error",
      durationMs: 820,
      code: "NSURLErrorTimedOut",
    },
    {
      event: "app.first_reply",
      atMs: 1_790_000_001_000,
      outcome: "ok",
      durationMs: 3_400,
      requestId: "Xk3mP9qL2vR8sT1uW4yZ6aBc",
    },
    { event: "app.terminal_frame_gap", atMs: 1_790_000_002_000, outcome: "ok", maxGapMs: 1_250 },
  ],
  ...overrides,
});

describe("app telemetry", () => {
  it("accepts timings and codes", () => {
    expect(AppTelemetryBatchSchema.safeParse(batch()).success).toBe(true);
    const { deviceRef: _deviceRef, ...withoutRef } = batch();
    expect(AppTelemetryBatchSchema.safeParse(withoutRef).success).toBe(true);
  });

  it("refuses anything that could carry content or a credential", () => {
    const prompt = "summarize my private repo acme-internal";
    const refused = [
      { ...batch(), message: prompt },
      batch({ events: [{ event: "app.send_ack", atMs: 1, outcome: "error", code: prompt } as never] }),
      batch({
        events: [{ event: "app.send_ack", atMs: 1, outcome: "error", code: "sk-ant-api03-abcdef" } as never],
      }),
      batch({
        events: [
          { event: "app.send_ack", atMs: 1, outcome: "ok", requestId: "ghp_abcdefghijklmnop" } as never,
        ],
      }),
      batch({ events: [{ event: "app.send_ack", atMs: 1, outcome: "ok", text: prompt } as never] }),
      batch({ events: [{ event: "app.chat_text" as never, atMs: 1, outcome: "ok" }] }),
      batch({ appVersion: "2.4.0 (prompt)" }),
      batch({ events: [] }),
      batch({ events: Array.from({ length: APP_TELEMETRY_EVENTS_MAX + 1 }, () => batch().events[0]!) }),
    ];
    for (const candidate of refused) expect(AppTelemetryBatchSchema.safeParse(candidate).success).toBe(false);
  });

  it("stays node-free so the React Native app can bundle it", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/app-telemetry.ts"), "utf8");
    expect([...source.matchAll(/\bfrom\s+"([^"]+)"/gu)].map((match) => match[1])).toEqual(["zod"]);
  });
});
