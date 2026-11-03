// Real TCP proof refusals → hire attribution from the persisted hire journal → which pages (#324).
import { once } from "node:events";
import { Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FLEET_HEALTH_METRICS_PATH, FleetHealthMetricsSnapshotSchema } from "@clankie/protocol";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { registerFleetHealthMetricsRoutes } from "../src/app/fleet-health-metrics-routes.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import {
  FleetHealthMetrics,
  proofAlertCallerSummary,
  type ProofAlertCallers,
} from "../src/fleet-health-metrics.ts";
import { localFleetProof } from "../src/local-fleet-proof.ts";

it("pages only on Clankie hires' refusals: not exited callers, a hire's admission minute, or the owner's own panes", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-refusal-attribution-"));
  let now = Date.parse("2026-11-02T23:00:00Z");
  const fleetAlerts: { refusals: number; callers: string }[] = [];
  const workerAlerts: { pane: string; callers: string }[] = [];
  // The journal the service persists hires in; this file is the same format on disk.
  const owners = new HireOwners(join(root, "herdr-watches.json.owners.json"));
  const lead = { conversationId: "lead-conversation" };
  owners.bind("w1:p1", lead); // allocated, still starting: no seat bound yet
  owners.bind("w2:p2", lead, "term_hired", undefined, "occupant-hired"); // a bound hire
  owners.adopt("w4:p4", "term_adopted", "occupant-adopted", lead); // hand-started, adopted by messaging
  const metrics = new FleetHealthMetrics({
    now: () => now,
    caller: (pane) => new HireOwners(join(root, "herdr-watches.json.owners.json")).paneHire(pane),
    onAggregateProofAlert: (window, callers: ProofAlertCallers) => {
      fleetAlerts.push({ refusals: window.proof.refusals, callers: proofAlertCallerSummary(callers) });
      return true;
    },
    onProofAlert: (pane, _window, callers) => {
      workerAlerts.push({ pane, callers: proofAlertCallerSummary(callers) });
      return true;
    },
  });
  // Real proof over real sockets; with no Herdr binding every claim is refused missing_binding.
  const proof = localFleetProof({
    platform: "darwin",
    herdrBinary: "herdr",
    binding: async () => undefined,
    diagnostics: (event, pane) => metrics.observeProof("fleet", event, pane),
  });
  const app = new Hono();
  registerFleetHealthMetricsRoutes(app, {
    captain: createStubCaptain(),
    authenticateOperator: createBearerAuthenticator("attribution-test", { operatorId: "owner" }),
    fleetHealthMetrics: metrics,
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, environment) => {
      const url = new URL(request.url);
      if (url.pathname === "/proof")
        return Response.json(
          { accepted: await proof(environment.incoming.socket, url.searchParams.get("pane") ?? "") },
          { status: 403 },
        );
      return app.fetch(request);
    },
  });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing real proof TCP listener");
  const host = `http://127.0.0.1:${address.port}`;
  const refuse = async (pane: string, times = 1) => {
    for (let count = 0; count < times; count++) {
      const response = await fetch(`${host}/proof?pane=${encodeURIComponent(pane)}`);
      expect(await response.json()).toEqual({ accepted: false });
    }
  };
  // Sustains a pane's refusals past the one-minute persistence rule.
  const sustain = async (pane: string) => {
    await refuse(pane, 100);
    now += 30_000;
    await refuse(pane);
    now += 30_001;
    await refuse(pane);
  };
  const metricsSnapshot = async () =>
    FleetHealthMetricsSnapshotSchema.parse(
      await (
        await fetch(`${host}${FLEET_HEALTH_METRICS_PATH}`, {
          headers: { authorization: "Bearer attribution-test" },
        })
      ).json(),
    );
  try {
    // The owner's own pane and an adopted hand-started seat: sustained real refusals never page,
    // and both still show in clankie metrics --fleet.
    await sustain("w9:p9");
    await sustain("w4:p4");
    expect(fleetAlerts).toEqual([]);
    expect(workerAlerts).toEqual([]);
    let shown = await metricsSnapshot();
    expect(shown.windows[0].proof.byReason).toEqual({ missing_binding: 204 });
    expect(shown.callers?.map((caller) => [caller.claimedPane, caller.window.proof.refusals])).toEqual([
      ["w4:p4", 102],
      ["w9:p9", 102],
    ]);

    // A caller that exited before its check finished never pages, even from a hire.
    now += 6 * 60_000;
    for (let count = 0; count < 102; count++)
      metrics.observeProof("fleet", { source: "proof", reason: "caller_exited" }, "w2:p2");
    now += 60_001;
    metrics.observeProof("fleet", { source: "proof", reason: "caller_exited" }, "w2:p2");
    expect(fleetAlerts).toEqual([]);
    expect(workerAlerts).toEqual([]);

    // A starting hire's own calls are refused not_member while admission completes: no page.
    now += 6 * 60_000;
    for (let count = 0; count < 100; count++)
      metrics.observeProof("fleet", { source: "proof", reason: "not_member" }, "w1:p1");
    now += 59_000;
    metrics.observeProof("fleet", { source: "proof", reason: "not_member" }, "w1:p1");
    expect(fleetAlerts).toEqual([]);
    expect(workerAlerts).toEqual([]);
    expect((await metricsSnapshot()).windows[0].proof.byReason.not_member).toBe(101);

    // Past its first minute, the same hire's not_member is genuine and pages, naming only it.
    now += 2_000;
    for (let count = 0; count < 100; count++)
      metrics.observeProof("fleet", { source: "proof", reason: "not_member" }, "w1:p1");
    now += 60_001;
    metrics.observeProof("fleet", { source: "proof", reason: "not_member" }, "w1:p1");
    expect(fleetAlerts).toEqual([{ refusals: 101, callers: "w1:p1" }]);
    await Promise.resolve(); // the alert settles (and starts its cooldown) before the clock moves

    // A bound hire's real refusals page too, and the alert names it, not the owner's pane
    // refusing beside it.
    now += 10 * 60_000;
    await refuse("w2:p2"); // first sighting starts only not_member's grace
    await refuse("w9:p9", 50);
    await sustain("w2:p2");
    expect(fleetAlerts).toHaveLength(2);
    expect(fleetAlerts[1]).toEqual({ refusals: 103, callers: "w2:p2" });
    shown = await metricsSnapshot();
    expect(shown.callers?.find((caller) => caller.claimedPane === "w9:p9")?.window.proof.refusals).toBe(50);
  } finally {
    if (server instanceof HttpServer) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
