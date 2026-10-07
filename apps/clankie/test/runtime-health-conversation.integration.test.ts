import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import type { RuntimeHealthObservation } from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { RuntimeHealthObserver } from "../src/runtime-health.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

// VUH-1702: the alert reaches the owner's default conversation through the
// ordinary conversation record, even when no native seat can take a delivery
// (the operator seat's outbox may be blocked; VUH-1779). No model turn runs.
it("slow health records exactly one alarm and one recovery in the default conversation with no model turn and no native seat", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-health-conversation-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let slow = true;
  const server = createServer((_request, response) => {
    setTimeout(
      () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      },
      slow ? 250 : 0,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");

  let modelTurns = 0;
  const deliveries: { conversationId: string; outcome: string; reason: string }[] = [];
  const captain = createCaptain({ herdrAvailable: () => false } as unknown as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
    runtimeProvider: {
      heartbeat: {
        begin: () => {
          modelTurns++;
          return () => {};
        },
      },
    } as never,
    onHealthAlertDelivery: (result) => deliveries.push(result),
  });
  cleanup.push(() => captain.close());

  const observations: RuntimeHealthObservation[] = [];
  const observer = new RuntimeHealthObserver({
    settings: async () => ({
      enabled: true,
      // Process CPU stays out of this case; the real busy-loop case is runtime-health-observer.
      cpuPercent: 1000,
      healthLatencyMs: 100,
      sustainedMs: 300,
      sampleIntervalMs: 100,
      cooldownMs: 60_000,
    }),
    healthUrl: `http://127.0.0.1:${address.port}/health`,
    notify: (text) => captain.notifyRuntimeHealthAlert(text),
    record: (text) => captain.recordRuntimeHealthNotice(text),
    observed: (observation) => observations.push(observation),
  });
  cleanup.push(async () => observer.stop());
  observer.start();
  await vi.waitFor(() => expect(observer.snapshot().state).toBe("alarm"), { timeout: 5_000, interval: 50 });
  // No seat can take it, yet the owner's conversation holds the alarm.
  expect(observer.snapshot()).toMatchObject({ delivery: "unavailable", recorded: true });
  // Keep the incident sustained across further samples: still one alarm.
  await new Promise((resolve) => setTimeout(resolve, 400));
  slow = false;
  await vi.waitFor(() => expect(observer.snapshot().lastRecoveryAt).toBeDefined(), {
    timeout: 5_000,
    interval: 50,
  });
  expect(observer.snapshot()).toMatchObject({ state: "healthy", delivery: "unavailable", recorded: true });
  observer.stop();

  const conversationId = "global-default";
  const replay = await captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "replay",
    replay: { schemaVersion: 1, conversationId, surfaceClientId: "test" },
  });
  if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("page expected");
  const notices = replay.result.events.flatMap((event) =>
    event.type === "message" && event.role === "external" ? [event.text] : [],
  );
  expect(notices).toHaveLength(2);
  expect(notices[0]).toMatch(/^Runtime health alarm: health held for \d+ms/u);
  expect(notices[0]).toContain("threshold 100ms");
  expect(notices[1]).toContain(
    `Runtime health recovered after ${observer.snapshot().lastIncidentDurationMs}ms`,
  );
  expect(observer.snapshot().lastIncidentDurationMs).toBeGreaterThanOrEqual(300);
  // The alert queued no turn and spent no model call.
  expect(replay.result.events.some((event) => event.type === "turn")).toBe(false);
  expect(modelTurns).toBe(0);
  // There is no native seat to nudge; that never gated the alert.
  expect(deliveries.every((delivery) => delivery.outcome === "unavailable")).toBe(true);
  expect(observations.filter((observation) => observation.state === "alarm").length).toBeGreaterThan(1);

  // A retried notice with the same text is recorded once; the seat result stays honest.
  expect(await captain.notifyRuntimeHealthAlert(notices[0]!)).toBe(false);
  const again = await captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "replay",
    replay: { schemaVersion: 1, conversationId, surfaceClientId: "test" },
  });
  if (again.op !== "replay" || again.result.status !== "page") throw new Error("page expected");
  expect(
    again.result.events.filter((event) => event.type === "message" && event.role === "external"),
  ).toHaveLength(2);
}, 20_000);
