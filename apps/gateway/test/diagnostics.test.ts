import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PublicGatewayTunnelFrameSchema,
  type PublicGatewayRequestFrame,
  type PublicGatewayTunnelFrame,
} from "@clankie/protocol/public-gateway";
import { APP_TELEMETRY_PATH, type AppTelemetryBatch } from "@clankie/protocol/app-telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createPublicGateway, type PublicGateway } from "../src/gateway.ts";

/** The metadata the gateway ships to central logs (VUH-1364, docs/observability.md G1–G4). */

const hostId = "mac_james_12345678";
const hostToken = "gateway-host-token-that-is-longer-than-thirty-two-characters";
const MARKER = "customer-secret-marker-acme-private-repo";
type Log = { readonly fields: Readonly<Record<string, unknown>>; readonly message: string };
const openGateways: PublicGateway[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  await Promise.all(openGateways.splice(0).map((gateway) => gateway.close()));
});

describe("gateway diagnostics", () => {
  it("names every exchange to the app and logs the ones the gateway ends itself", async () => {
    const logs: Log[] = [];
    const { origin } = await startGateway(logs);

    const offline = await fetch(`${origin}/h/${hostId}/v1/gateway/encrypted`, {
      method: "POST",
      body: MARKER,
    });
    expect(offline.status).toBe(503);
    expect(failures(logs)).toEqual([
      { event: "gateway.exchange.failed", hostId, status: 503, code: "host_unavailable", durationMs: 0 },
    ]);

    const host = await connectHost(origin);
    openSockets.push(host);
    const completed = fetch(`${origin}/h/${hostId}/v1/gateway/encrypted`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: MARKER,
    });
    const frame = await nextRequest(host);
    respond(host, frame, 200, MARKER);
    const response = await completed;
    expect(response.headers.get("x-clankie-request-id")).toBe(frame.requestId);
    await response.text();

    // The host drops mid-exchange: the device gets a 503 that still names its exchange.
    const dropped = fetch(`${origin}/h/${hostId}/v1/gateway/encrypted`, { method: "POST", body: MARKER });
    const pending = await nextRequest(host);
    host.close(4002, "going away");
    const failed = await dropped;
    expect(failed.status).toBe(503);
    expect(failed.headers.get("x-clankie-request-id")).toBe(pending.requestId);
    await waitFor(() => logs.some((log) => log.message === "gateway host disconnected"));
    expect(failures(logs).at(-1)).toMatchObject({
      requestId: pending.requestId,
      status: 503,
      code: "host_unavailable",
    });
    const disconnected = logs.find((log) => log.message === "gateway host disconnected")!.fields;
    expect(disconnected).toMatchObject({ event: "gateway.host.disconnected", hostId, closeCode: 4002 });
    expect(typeof disconnected.connectedMs).toBe("number");

    expect(JSON.stringify(logs)).not.toContain(MARKER);
  });

  it("records valid app telemetry, one metadata line per event", async () => {
    const logs: Log[] = [];
    const { origin } = await startGateway(logs);
    const response = await postTelemetry(origin, batch());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 2 });
    expect(logs.filter((log) => log.message === "app telemetry").map((log) => log.fields)).toEqual([
      {
        event: "app.reconnect",
        atMs: 1_790_000_000_000,
        outcome: "error",
        durationMs: 8_000,
        code: "NSURLErrorTimedOut",
        hostId,
        deviceRef: "dv1_abcdefghijklmnopqrstuv",
        platform: "ios",
        appVersion: "2.4.0",
      },
      {
        event: "app.first_reply",
        atMs: 1_790_000_001_000,
        outcome: "ok",
        durationMs: 3_400,
        requestId: "Xk3mP9qL2vR8sT1uW4yZ6aBc",
        hostId,
        deviceRef: "dv1_abcdefghijklmnopqrstuv",
        platform: "ios",
        appVersion: "2.4.0",
      },
    ]);
  });

  it("refuses content, oversize batches and floods without logging them", async () => {
    const logs: Log[] = [];
    const { origin } = await startGateway(logs);
    const smuggled = { ...batch(), events: [{ ...batch().events[0]!, text: MARKER }] };
    expect((await postTelemetry(origin, smuggled)).status).toBe(400);
    expect((await postTelemetry(origin, { ...batch(), note: MARKER })).status).toBe(400);
    expect(
      (await postTelemetry(origin, batch({ events: [{ ...batch().events[0]!, code: MARKER }] }))).status,
    ).toBe(400);
    const oversized = await fetch(`${origin}${APP_TELEMETRY_PATH}`, {
      method: "POST",
      body: "x".repeat(9_000),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "telemetry_too_large" });
    expect(JSON.stringify(logs)).not.toContain(MARKER);
    expect(logs.some((log) => log.message === "app telemetry")).toBe(false);

    const statuses: number[] = [];
    for (let index = 0; index < 14; index += 1) statuses.push((await postTelemetry(origin, batch())).status);
    expect(statuses.slice(0, 12).every((status) => status === 202)).toBe(true);
    const throttled = await postTelemetry(origin, batch());
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("60");
    // Another host's app is not starved by the first.
    expect((await postTelemetry(origin, batch({ hostId: "another_host_12345678" }))).status).toBe(202);
  });
});

describe("app telemetry under open traffic", () => {
  it("bounds parsing, log lines and memory against a flood of forged host routes", async () => {
    const logs: Log[] = [];
    const { origin } = await startGateway(logs);
    const statuses = new Map<number, number>();
    const full = batch({ events: Array.from({ length: 32 }, () => batch().events[0]!) });
    // 600 requests, each claiming a fresh host route with a full batch.
    for (let wave = 0; wave < 6; wave += 1) {
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          postTelemetry(origin, {
            ...full,
            hostId: `forged_host_${String(wave * 100 + index).padStart(8, "0")}`,
          }).then((response) => response.status),
        ),
      );
      for (const status of results) statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    const lines = logs.filter((log) => log.message === "app telemetry").length;
    // The event budget's burst (400) plus a few seconds of refill, never 600 × 32.
    expect(lines).toBeLessThanOrEqual(400 + 32 * 3);
    expect(statuses.get(429) ?? 0).toBeGreaterThan(400);
    const summary = logs.find((log) => log.message === "gateway telemetry throttled");
    expect(summary?.fields).toMatchObject({ event: "gateway.telemetry.throttled" });
    // Summaries, not one line per refusal.
    expect(logs.filter((log) => log.message === "gateway telemetry throttled").length).toBe(1);
    expect((await fetch(`${origin}/health`)).status).toBe(200);
  }, 30_000);
});

function batch(overrides: Partial<AppTelemetryBatch> = {}): AppTelemetryBatch {
  return {
    v: 1,
    hostId,
    deviceRef: "dv1_abcdefghijklmnopqrstuv",
    platform: "ios",
    appVersion: "2.4.0",
    events: [
      {
        event: "app.reconnect",
        atMs: 1_790_000_000_000,
        outcome: "error",
        durationMs: 8_000,
        code: "NSURLErrorTimedOut",
      },
      {
        event: "app.first_reply",
        atMs: 1_790_000_001_000,
        outcome: "ok",
        durationMs: 3_400,
        requestId: "Xk3mP9qL2vR8sT1uW4yZ6aBc",
      },
    ],
    ...overrides,
  };
}

function postTelemetry(origin: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${APP_TELEMETRY_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function failures(logs: readonly Log[]): Readonly<Record<string, unknown>>[] {
  return logs.filter((log) => log.message === "gateway exchange failed").map((log) => log.fields);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2_000 && !condition(); waited += 10)
    await new Promise((wake) => setTimeout(wake, 10));
}

async function startGateway(logs: Log[]): Promise<{ readonly origin: string }> {
  const gateway = createPublicGateway({
    hostTokens: new Map([[hostId, hostToken]]),
    logger: {
      info: (fields, message) => logs.push({ fields, message }),
      warn: (fields, message) => logs.push({ fields, message }),
    },
  });
  openGateways.push(gateway);
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const address = gateway.server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}` };
}

async function connectHost(origin: string): Promise<WebSocket> {
  const socket = new WebSocket(
    `${origin.replace("http", "ws")}${PUBLIC_GATEWAY_HOST_CONNECT_PATH}?hostId=${hostId}`,
    {
      headers: { authorization: `Bearer ${hostToken}` },
    },
  );
  await once(socket, "open");
  return socket;
}

async function nextRequest(socket: WebSocket): Promise<PublicGatewayRequestFrame> {
  const [data] = (await once(socket, "message")) as [Buffer];
  const frame = PublicGatewayTunnelFrameSchema.parse(JSON.parse(data.toString()));
  if (frame.kind !== "request") throw new Error(`Expected request, received ${frame.kind}`);
  return frame;
}

function respond(socket: WebSocket, request: PublicGatewayRequestFrame, status: number, body: string): void {
  const frames: PublicGatewayTunnelFrame[] = [
    { schemaVersion: 1, kind: "response_start", requestId: request.requestId, status, headers: [] },
    {
      schemaVersion: 1,
      kind: "response_chunk",
      requestId: request.requestId,
      sequence: 0,
      bodyBase64: Buffer.from(body).toString("base64"),
    },
    { schemaVersion: 1, kind: "response_end", requestId: request.requestId },
  ];
  for (const frame of frames) socket.send(JSON.stringify(frame));
}
