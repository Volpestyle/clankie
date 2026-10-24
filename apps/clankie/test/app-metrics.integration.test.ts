import { expect, it } from "vitest";
import {
  APP_METRICS_PATH,
  APP_METRICS_POST_PATH,
  type AppMetricsReport,
} from "@clankie/protocol/app-metrics";
import { publicGatewayTargetFor } from "@clankie/protocol/public-gateway";
import { runMetricsCommand } from "../../tui/src/command/metrics.ts";
import { createQaService } from "./fixtures/qa-service.ts";

const summary = {
  destination: "messages",
  count: 12,
  firstFrameMs: { p50: 20, p95: 125 },
  longTaskMs: { p50: 0, p95: 87 },
  slowCount: 1,
} as const;
const report: AppMetricsReport = { platform: "ios", summaries: [summary] };

async function paired(host: Awaited<ReturnType<typeof createQaService>>, automation = true) {
  const offer = await (
    await host.operator(
      "/v1/pairing/offer",
      automation ? { run: { runId: "app-metrics-test", purpose: "test", ttlSeconds: 900 } } : {},
    )
  ).json();
  const pending = await (
    await fetch(`${host.baseUrl}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: offer.code, device: { name: "Timing test", platform: "ios" } }),
    })
  ).json();
  const complete = await fetch(`${host.baseUrl}/v1/pairing/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completionToken: pending.completionToken, acceptedGrants: pending.offeredGrants }),
  });
  expect(complete.status).toBe(200);
  return (await complete.json()) as { deviceId: string; deviceToken: string };
}

it("a real paired device reports content-free rolling timings and the operator reads them through metrics --app", async () => {
  const host = await createQaService();
  try {
    const device = await paired(host);
    const post = (value: unknown, token: string | undefined = device.deviceToken) =>
      fetch(host.baseUrl + APP_METRICS_POST_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(value),
      });
    expect((await post(report, "")).status).toBe(401);
    expect((await post(report, host.operatorToken)).status).toBe(401);
    expect(
      (
        await fetch(host.baseUrl + APP_METRICS_PATH, {
          headers: { authorization: `Bearer ${device.deviceToken}` },
        })
      ).status,
    ).toBe(401);
    expect((await post(report)).status).toBe(202);
    expect((await post(report)).status).toBe(429);
    const read = () =>
      runMetricsCommand(["--app"], {
        host: host.baseUrl,
        env: { CLANKIE_OPERATOR_TOKEN: host.operatorToken },
      });
    expect(await read()).toEqual({ ok: true, app: { devices: [{ deviceId: device.deviceId, ...report }] } });
    for (const invalid of [
      { ...report, deviceId: "spoofed" },
      { ...report, text: "content" },
      { ...report, summaries: [{ ...summary, destination: "private-project" }] },
      { ...report, summaries: [{ ...summary, count: 65 }] },
      { ...report, summaries: [{ ...summary, slowCount: 13 }] },
      { ...report, summaries: [{ ...summary, firstFrameMs: { p50: 200, p95: 100 } }] },
      { ...report, summaries: [{ ...summary, longTaskMs: { p50: -1, p95: 100 } }] },
      { ...report, summaries: [summary, summary] },
    ])
      expect((await post(invalid)).status).toBe(400);
    expect((await post({ padding: "x".repeat(4096) })).status).toBe(413);
    host.advance(1000);
    const replacement = {
      platform: "ios",
      summaries: [{ ...summary, count: 1, longTaskMs: null, slowCount: 0 }],
    };
    expect((await post(replacement)).status).toBe(202);
    expect(await read()).toEqual({
      ok: true,
      app: { devices: [{ deviceId: device.deviceId, ...replacement }] },
    });
    expect(publicGatewayTargetFor("POST", APP_METRICS_POST_PATH)).toBe("control");
    expect(publicGatewayTargetFor("GET", APP_METRICS_PATH)).toBeUndefined();
    expect((await host.operator(`/v1/devices/${device.deviceId}/revoke`)).status).toBe(200);
    expect((await post(report)).status).toBe(401);
    expect(await read()).toEqual({ ok: true, app: { devices: [] } });
  } finally {
    await host.close();
  }
});

it("bounds device/platform windows, evicts the oldest, expires idle data and resets after service restart", async () => {
  const host = await createQaService();
  try {
    const ids: string[] = [];
    let lastDevice!: Awaited<ReturnType<typeof paired>>;
    for (let i = 0; i < 13; i++) {
      const device = await paired(host, false);
      ids.push(device.deviceId);
      lastDevice = device;
      for (const platform of ["ios", "ipados", "macos", "android", "web"]) {
        expect(
          (
            await fetch(host.baseUrl + APP_METRICS_POST_PATH, {
              method: "POST",
              headers: { authorization: `Bearer ${device.deviceToken}`, "content-type": "application/json" },
              body: JSON.stringify({ ...report, platform }),
            })
          ).status,
        ).toBe(202);
      }
    }
    const read = () =>
      runMetricsCommand(["--app"], {
        host: host.baseUrl,
        env: { CLANKIE_OPERATOR_TOKEN: host.operatorToken },
      });
    const result = await read();
    expect("app" in result && result.app.devices).toHaveLength(64);
    expect(
      "app" in result && result.app.devices.some((row) => row.deviceId === ids[0] && row.platform === "ios"),
    ).toBe(false);
    expect("app" in result && result.app.devices.filter((row) => row.deviceId === ids[12])).toHaveLength(5);
    await host.restart();
    expect(await read()).toEqual({ ok: true, app: { devices: [] } });
    expect(
      (
        await fetch(host.baseUrl + APP_METRICS_POST_PATH, {
          method: "POST",
          headers: { authorization: `Bearer ${lastDevice.deviceToken}`, "content-type": "application/json" },
          body: JSON.stringify(report),
        })
      ).status,
    ).toBe(202);
    host.advance(59 * 60_000);
    const fresh = await read();
    expect("app" in fresh && fresh.app.devices).toHaveLength(1);
    host.advance(60_000);
    expect(await read()).toEqual({ ok: true, app: { devices: [] } });
    await expect(runMetricsCommand(["--app", "--fleet"], { env: {} })).rejects.toThrow("Usage:");
  } finally {
    await host.close();
  }
});
