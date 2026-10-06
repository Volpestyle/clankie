import { once } from "node:events";
import { Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { createLogger } from "@clankie/observability";
import { FLEET_HEALTH_METRICS_PATH, FleetHealthMetricsSnapshotSchema } from "@clankie/protocol";
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
