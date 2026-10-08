import { once } from "node:events";
import { Server as HttpServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { NextTurnMailbox } from "../src/captain/next-turn-mailbox.ts";

it("reads a held next-turn alert's original acknowledgment after reload without rewriting its journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proof-alert-hook-"));
  const path = join(directory, "mail.json");
  try {
    const mailbox = new NextTurnMailbox(path);
    mailbox.observe("owned-seat", "original-binding", "original-native-process");
    const original = mailbox.store("owned-seat", "original-binding", "Owned held alert");
    expect(original.deliveryStage).toBe("stored");
    const id = "messageId" in original ? original.messageId! : "";
    expect(mailbox.acknowledged("owned-seat", "original-binding", id, "Owned held alert")).toBe(false);
    expect(mailbox.take("owned-seat", "original-binding")?.messageIds).toEqual([id]);
    expect(mailbox.acknowledged("owned-seat", "original-binding", id, "Owned held alert")).toBe(false);
    mailbox.acknowledge("owned-seat", "original-binding", [id]);
    const bytes = await readFile(path, "utf8");
    const reloaded = new NextTurnMailbox(path);
    expect(reloaded.acknowledged("owned-seat", "wrong-binding", id, "Owned held alert")).toBe(false);
    expect(reloaded.acknowledged("owned-seat", "original-binding", "invented", "Owned held alert")).toBe(
      false,
    );
    expect(reloaded.acknowledged("owned-seat", "original-binding", id, "Different content")).toBe(false);
    expect(reloaded.acknowledged("owned-seat", "original-binding", id, "Owned held alert")).toBe(true);
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect(reloaded.take("owned-seat", "original-binding")).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["seat", "aggregate"] as const)(
  "holds an unconfirmed %s proof alert across inactivity and bounded admission until its exact original acknowledgment",
  async (scope) => {
    const directory = await mkdtemp(join(tmpdir(), "proof-alert-receipt-"));
    const outbox = new SeatOutbox({ uncertaintyPath: join(directory, "receipts.json"), boundGraceMs: 30 });
    let now = Date.parse("2026-10-06T12:00:00Z"),
      attempts = 0;
    const binding = "b".repeat(64);
    const deliver = async () => {
      attempts++;
      const result = await outbox.deliver({
        kind: "message",
        conversationId: "owned-protocol-client",
        source: "service",
        content: "Owned proof alert",
        wantsReply: false,
        recipientBinding: binding,
      });
      if (result.outcome === "unconfirmed")
        return {
          outcome: "unconfirmed" as const,
          acknowledged: () => outbox.recoveryAcknowledged(result.messageId),
        };
      return { outcome: result.outcome === "delivered" ? ("accepted" as const) : ("unavailable" as const) };
    };
    const metrics = new FleetHealthMetrics({
      now: () => now,
      ...(scope === "seat" ? { onProofAlert: deliver } : { onAggregateProofAlert: deliver }),
    });
    const refusal = () =>
      metrics.observeProof(
        "fleet",
        { source: "proof", reason: "missing_binding" },
        scope === "seat" ? "w1:p1" : undefined,
      );
    try {
      for (let count = 0; count < 100; count++) refusal();
      now += 60_000;
      const poll = outbox.poll(5_000, undefined, binding);
      refusal();
      const [original] = await poll;
      expect(original).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(outbox.uncertain()).toBe(true);
      // No proof observations for longer than the seat/rate expiry interval.
      now += 6 * 60_000;
      expect(metrics.snapshot().windows[0].proof.attempts).toBe(0);
      refusal();
      expect(attempts).toBe(1);
      // Fill the remaining bounded slots with genuine collector observations.
      // Overflow must refuse admission, never evict the unresolved original.
      const fillerCount = scope === "seat" ? 511 : 512;
      for (let seat = 0; seat < fillerCount; seat++)
        metrics.observeProof("fleet", { source: "proof_success" }, `w2:p${seat}`);
      metrics.observeProof("fleet", { source: "proof", reason: "missing_binding" }, "w3:p1");
      refusal();
      expect(attempts).toBe(1);
      expect(metrics.snapshot().totals.proof.attempts).toBe(fillerCount + 104);
      expect(outbox.acknowledge("invented-original", binding)).toBe(false);
      expect(outbox.acknowledge(original!.id, "c".repeat(64))).toBe(false);
      expect(outbox.recoveryAcknowledged(original!.id)).toBe(false);
      expect(outbox.acknowledge(original!.id, binding)).toBe(true);
      refusal();
      expect(attempts).toBe(1);
      for (let minute = 0; minute < 4; minute++) {
        now += 60_000;
        refusal();
      }
      expect(attempts).toBe(1);
      now += 60_000;
      // The original high-volume bucket has expired. A fresh qualifying
      // sample must persist again before another deliberate dispatch.
      for (let count = 0; count < 100; count++) refusal();
      now += 60_000;
      refusal();
      expect(attempts).toBe(2);
    } finally {
      outbox.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("counts terminal real socket refusals, keeps diagnostics separate, and serves authenticated 5/60-minute CLI rates", async () => {
  let now = Date.parse("2026-10-05T12:00:00Z");
  const alerts: string[] = [];
  const metrics = new FleetHealthMetrics({
    now: () => now,
    onProofAlert: (pane, window) => {
      alerts.push(`${pane}:${window.proofRefusalRate}`);
      return true;
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
    expect(alerts).toEqual([]);
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

it("counts a sparse recorded startup sample without paging and requires a sustained real TCP refusal sample", async () => {
  let now = Date.parse("2026-10-08T03:53:56Z");
  const alerts: import("@clankie/protocol").FleetHealthMetricsWindow[] = [];
  const metrics = new FleetHealthMetrics({
    now: () => now,
    onAggregateProofAlert: (rates) => {
      alerts.push(rates);
      return true;
    },
  });
  // Golden contract input grounded in the owner's live 2/194 startup sample.
  // These observations do not claim a fresh native producer run.
  for (let count = 0; count < 192; count++) metrics.observeProof("fleet", { source: "proof_success" });
  for (let count = 0; count < 2; count++)
    metrics.observeProof("fleet", { source: "proof", reason: "not_member" });
  now += 60_000;
  expect(metrics.snapshot().windows[0].proof).toEqual({
    attempts: 194,
    refusals: 2,
    byReason: { not_member: 2 },
  });
  expect(alerts).toEqual([]);
  const proof = localFleetProof({
    platform: "darwin",
    herdrBinary: "herdr",
    binding: async () => undefined,
    diagnostics: (event, pane) => metrics.observeProof("fleet", event, pane),
  });
  const app = new Hono();
  registerFleetHealthMetricsRoutes(app, {
    captain: createStubCaptain(),
    authenticateOperator: createBearerAuthenticator("policy-test", { operatorId: "owner" }),
    fleetHealthMetrics: metrics,
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, environment) => {
      if (new URL(request.url).pathname === "/proof")
        return Response.json({ accepted: await proof(environment.incoming.socket, "") }, { status: 403 });
      return app.fetch(request);
    },
  });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing real policy TCP listener");
  const host = `http://127.0.0.1:${address.port}`;
  const refuse = async () => {
    const response = await fetch(`${host}/proof`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ accepted: false });
  };
  try {
    // Expiration resets persistence; an old elevated sample cannot qualify a new one.
    now += 5 * 60_000;
    for (let count = 0; count < 99; count++) await refuse();
    now += 60_000;
    await refuse();
    expect(alerts).toEqual([]);
    now += 59_999;
    await refuse();
    expect(alerts).toEqual([]);
    now += 1;
    await refuse();
    expect(alerts).toHaveLength(1);
    const response = await fetch(`${host}${FLEET_HEALTH_METRICS_PATH}`, {
      headers: { authorization: "Bearer policy-test" },
    });
    const snapshot = FleetHealthMetricsSnapshotSchema.parse(await response.json());
    expect(alerts[0]).toEqual(snapshot.windows[0]);
    expect(snapshot.windows[0].proof).toEqual({
      attempts: 102,
      refusals: 102,
      byReason: { invalid_pane: 102 },
    });
    await Promise.resolve();
    now += 60_000;
    await refuse();
    expect(alerts).toHaveLength(1);
  } finally {
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
