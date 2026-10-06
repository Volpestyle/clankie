import { once } from "node:events";
import { Server as HttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { createLogger } from "@clankie/observability";
import {
  FLEET_HEALTH_METRICS_PATH,
  FleetHealthMetricsSnapshotSchema,
  FleetNativeDiagnosticReasonSchema,
} from "@clankie/protocol";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { registerFleetHealthMetricsRoutes } from "../src/app/fleet-health-metrics-routes.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";
import { localFleetProof } from "../src/local-fleet-proof.ts";
import { localProofDiagnostics } from "../src/local-fleet-proof-log.ts";
import { closeNativeProcessObservers, nativeProcessRequest } from "../src/native-process-transport.ts";
import { runMetricsCommand } from "../../tui/src/command/metrics.ts";
import { NativeProcessDiagnosticSchema } from "../src/local-fleet-process.ts";

it("counts terminal real socket refusals, keeps diagnostics separate, and serves authenticated 5/60-minute CLI rates", async () => {
  let now = Date.parse("2026-10-05T12:00:00Z");
  const alerts: string[] = [];
  const metrics = new FleetHealthMetrics({
    now: () => now,
    onProofAlert: (pane, window) => {
      alerts.push(`${pane}:${window.proofRefusalRate}`);
    },
  });
  const logger = createLogger({ service: "fleet-metrics-integration" }, { level: "silent" });
  const diagnostics = localProofDiagnostics(logger, "fleet", metrics);
  const unavailable = localFleetProof({
    platform: "darwin",
    herdrBinary: "herdr",
    binding: async () => undefined,
    diagnostics,
  });
  const unsupported = localFleetProof({
    platform: "unsupported",
    herdrBinary: "herdr",
    binding: async () => undefined,
    diagnostics,
  });
  const app = new Hono();
  registerFleetHealthMetricsRoutes(app, {
    captain: createStubCaptain(),
    authenticateOperator: createBearerAuthenticator("metrics-test", { operatorId: "owner" }),
    fleetHealthMetrics: metrics,
  });
  let socket: Socket | undefined;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, environment) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/proof/")) {
        socket = environment.incoming.socket;
        const mode = path.slice("/proof/".length);
        const accepted = await (mode === "unsupported" ? unsupported : unavailable)(
          socket,
          mode === "invalid" ? "PID_PATH_ARGV_SENTINEL_/private/sensitive" : "w1:p1",
        );
        return Response.json({ accepted }, { status: accepted ? 200 : 403 });
      }
      return app.fetch(request);
    },
  });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing real TCP listener");
  const host = `http://127.0.0.1:${address.port}`;
  try {
    for (const mode of ["invalid", "missing", "unsupported"]) {
      const response = await fetch(`${host}/proof/${mode}`, { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ accepted: false });
    }
    const closed = once(socket!, "close");
    socket!.destroy();
    await closed;
    expect(await unavailable(socket!, "w1:p1")).toBe(false);
    // A transport rejected before any proof finishes cannot inflate proof refusals.
    expect(
      await nativeProcessRequest("relative-sensitive-path", ["private-argv"], undefined, (reason) =>
        metrics.observeProof("fleet", { source: "transport", reason }),
      ),
    ).toBeUndefined();
    const anonymous = await fetch(`${host}${FLEET_HEALTH_METRICS_PATH}`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain("missing_binding");
    const result = await runMetricsCommand(["--fleet"], {
      host,
      env: { CLANKIE_OPERATOR_TOKEN: "metrics-test" },
    });
    expect(result.ok).toBe(true);
    if (!("fleet" in result)) throw new Error("No fleet metrics from CLI");
    const snapshot = FleetHealthMetricsSnapshotSchema.parse(result.fleet);
    expect(snapshot.totals.proof).toEqual({
      attempts: 4,
      refusals: 4,
      byReason: { invalid_pane: 1, missing_binding: 1, unsupported_platform: 1, closed_socket: 1 },
    });
    expect(snapshot.totals.transportDiagnostics).toEqual({ protocol_invalid: 1 });
    expect(snapshot.windows[0]).toMatchObject({
      minutes: 5,
      proofRefusalRate: 1,
      proofRefusalsPerMinute: 0.8,
    });
    expect(snapshot.windows[1]).toMatchObject({
      minutes: 60,
      proofRefusalRate: 1,
      proofRefusalsPerMinute: 4 / 60,
    });
    expect(alerts).toEqual(["w1:p1:1"]);
    const content = JSON.stringify(snapshot);
    expect(content).not.toMatch(
      /PID_PATH_ARGV_SENTINEL|private-sensitive|private-argv|w1:p1|\/private\/sensitive|\bpid\b/u,
    );
    now += 5 * 60_000;
    expect(metrics.snapshot().windows[0].proof.attempts).toBe(0);
    expect(metrics.snapshot().windows[1].proof.attempts).toBe(4);
    now += 55 * 60_000;
    expect(metrics.snapshot().windows[1].proof.attempts).toBe(0);
    expect(metrics.snapshot().totals.proof.attempts).toBe(4);
  } finally {
    await closeNativeProcessObservers();
    if (server instanceof HttpServer) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("carries the helper's complete fixed diagnostic vocabulary through the collector and authenticated HTTP schema", async () => {
  const source = await readFile(
    new URL("../../../integrations/fleet-proof/native-process-proof.c", import.meta.url),
    "utf8",
  );
  const declarations = new Map<string, string>();
  for (const [, stage, reason] of source.matchAll(/(?:diagnostic|refuse_at)\("([\w]+)",\s*"([\w]+)"/gu))
    declarations.set(reason!, stage!);
  const exhausted = /diagnostic\("completion", within_overall_budget\(\) \? "([\w]+)" : "([\w]+)"/u.exec(
    source,
  );
  expect(exhausted).not.toBeNull();
  for (const reason of exhausted!.slice(1)) declarations.set(reason, "completion");
  expect([...declarations.keys()].sort()).toEqual([...FleetNativeDiagnosticReasonSchema.options].sort());
  const metrics = new FleetHealthMetrics();
  const captured = JSON.parse(
    await readFile(
      new URL("./fixtures/local-fleet-proof/exhausted-diagnostics.json", import.meta.url),
      "utf8",
    ),
  ) as { samples: Array<{ checkpoint: "initial" | "final"; event: unknown }> };
  expect(captured.samples.map((sample) => NativeProcessDiagnosticSchema.parse(sample.event).reason)).toEqual([
    "budget_exhausted",
    "attempts_exhausted",
  ]);
  for (const sample of captured.samples)
    metrics.observeProof("fleet", {
      source: "native",
      checkpoint: sample.checkpoint,
      event: NativeProcessDiagnosticSchema.parse(sample.event),
    });
  // Source-grounded vocabulary contract samples; these do not claim the OS
  // produced clock/allocation failures or malformed kernel records.
  for (const [reason, stage] of declarations)
    metrics.observeProof("fleet", {
      source: "native",
      checkpoint: "initial",
      event: NativeProcessDiagnosticSchema.parse({
        schemaVersion: 1,
        reason,
        stage,
        errno: 0,
        attempt: 1,
        retry: false,
      }),
    });
  expect(
    NativeProcessDiagnosticSchema.safeParse({
      schemaVersion: 1,
      reason: "private-reason-/private/sensitive",
      stage: "process",
      errno: 0,
      attempt: 1,
      retry: false,
    }).success,
  ).toBe(false);
  const app = new Hono();
  registerFleetHealthMetricsRoutes(app, {
    captain: createStubCaptain(),
    authenticateOperator: createBearerAuthenticator("vocabulary-test", { operatorId: "owner" }),
    fleetHealthMetrics: metrics,
  });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing real TCP listener");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${FLEET_HEALTH_METRICS_PATH}`, {
      headers: { authorization: "Bearer vocabulary-test" },
    });
    expect(response.status).toBe(200);
    const snapshot = FleetHealthMetricsSnapshotSchema.parse(await response.json());
    const expected = Object.fromEntries([...declarations.keys()].map((reason) => [reason, 1]));
    expected.budget_exhausted = 2;
    expected.attempts_exhausted = 2;
    expect(snapshot.totals.nativeDiagnostics).toEqual(expected);
    for (const window of snapshot.windows) {
      expect(window.nativeDiagnostics).toEqual(expected);
      expect(window.proof).toEqual({ attempts: 0, refusals: 0, byReason: {} });
      expect(window.proofRefusalRate).toBe(0);
    }
    expect(snapshot.totals.proof).toEqual({ attempts: 0, refusals: 0, byReason: {} });
    expect(JSON.stringify(snapshot)).not.toMatch(/private-reason|\/private\/sensitive|\bpid\b|argv":/u);
  } finally {
    if (server instanceof HttpServer) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
