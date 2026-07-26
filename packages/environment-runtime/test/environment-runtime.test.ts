import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentSessionSpec, EnvironmentSessionSpecV2 } from "@clankie/interactive-environment";
import { afterEach, describe, expect, it } from "vitest";
import {
  EnvironmentRuntime,
  type EnvironmentAdapter,
  type EnvironmentAdapterActionRunning,
  type EnvironmentAdapterSession,
  type EnvironmentEventSink,
  type EnvironmentStartActionCommand,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeSession implements EnvironmentAdapterSession {
  readonly adapterSessionId: string;
  readonly started: string[] = [];
  readonly cancelled: string[] = [];
  stops = 0;
  pauses = 0;
  resumes = 0;
  hangStartAction = false;
  hangCancelAction = false;
  background = false;
  private backgroundCompletion:
    | {
        resolve: (value: { status: "completed"; outcome: Record<string, unknown> }) => void;
        reject: (reason: unknown) => void;
      }
    | undefined;
  constructor(adapterSessionId: string) {
    this.adapterSessionId = adapterSessionId;
  }
  pause(): Promise<void> {
    this.pauses += 1;
    return Promise.resolve();
  }
  resume(): Promise<void> {
    this.resumes += 1;
    return Promise.resolve();
  }
  startAction(command: EnvironmentStartActionCommand): Promise<void | EnvironmentAdapterActionRunning> {
    if (this.hangStartAction) return new Promise<void>(() => {});
    this.started.push(command.actionId);
    if (this.background) {
      const completion = new Promise<{ status: "completed"; outcome: Record<string, unknown> }>(
        (resolve, reject) => {
          this.backgroundCompletion = { resolve, reject };
        },
      );
      return Promise.resolve({ status: "running", completion });
    }
    return Promise.resolve();
  }
  finishBackground(outcome: Record<string, unknown>): void {
    this.backgroundCompletion?.resolve({ status: "completed", outcome });
  }
  cancelAction(actionId: string): Promise<void> {
    if (this.hangCancelAction) return new Promise<void>(() => {});
    this.cancelled.push(actionId);
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stops += 1;
    return Promise.resolve();
  }
}

class FakeAdapter implements EnvironmentAdapter {
  readonly sessions = new Map<string, FakeSession>();
  starts = 0;
  attaches = 0;
  start(spec: EnvironmentSessionSpecV2): Promise<EnvironmentAdapterSession> {
    this.starts += 1;
    const session = new FakeSession(`adapter-${spec.sessionId}`);
    this.sessions.set(session.adapterSessionId, session);
    return Promise.resolve(session);
  }
  attach(_spec: EnvironmentSessionSpecV2, id: string): Promise<EnvironmentAdapterSession | undefined> {
    this.attaches += 1;
    return Promise.resolve(this.sessions.get(id));
  }
}

const baseSpec = (sessionId: string): EnvironmentSessionSpec => ({
  schemaVersion: 1,
  sessionId,
  environmentKind: "fake",
  characterId: "clankie",
  worldId: "private-world",
  requestedBy: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
  initialGoalVersion: 4,
  resourceBounds: {
    serverId: "fake-server",
    worldId: "private-world",
    characterId: "clankie",
    allowedDimensions: ["overworld"],
    maxDistanceFromOrigin: 64,
    maxActionDurationMs: 1_000,
    maxBlockChangesPerAction: 4,
    capabilities: ["environment.test"],
  },
});

const command = (sessionId: string, actionId: string): EnvironmentStartActionCommand => ({
  schemaVersion: 1,
  commandId: `command-${actionId}`,
  type: "start_action",
  requestedAt: "2026-07-11T12:00:00.000Z",
  context: {
    sourceLane: "gameplay",
    authority: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
    correlationId: `corr-${actionId}`,
    expectedGoalVersion: 4,
  },
  sessionId,
  actionId,
  action: { kind: "fake_action" },
});

async function harness() {
  const rootDir = await mkdtemp(join(tmpdir(), "environment-runtime-"));
  roots.push(rootDir);
  const adapter = new FakeAdapter();
  const events: Parameters<EnvironmentEventSink["append"]>[0][] = [];
  const now = { value: new Date("2026-07-11T12:00:00.000Z") };
  const make = () =>
    new EnvironmentRuntime({
      rootDir,
      adapter,
      events: { append: (event) => (events.push(event), Promise.resolve()) },
      clock: () => now.value,
      randomToken: () => "grant-marker",
    });
  return { adapter, events, make, now, rootDir };
}

describe("EnvironmentRuntime fake-adapter contract", () => {
  it("dual-reads legacy v1 sessions and single-writes canonical v2 records", async () => {
    const { make, rootDir } = await harness();
    const grant = await make().start({
      spec: baseSpec("legacy-v1-session"),
      holderId: "runner",
      correlationId: "legacy-migration",
    });
    expect(grant.session).toMatchObject({
      spec: { schemaVersion: 2, resourceBounds: { profile: "legacy_v1", legacyEnvironmentKind: "fake" } },
      lease: { schemaVersion: 2, resourceBounds: { profile: "legacy_v1" } },
    });
    const file = (await readdir(join(rootDir, "environment-sessions"))).find((name) =>
      name.endsWith(".json"),
    )!;
    const stored = JSON.parse(await readFile(join(rootDir, "environment-sessions", file), "utf8")) as {
      schemaVersion: number;
      spec: { schemaVersion: number };
      lease: { schemaVersion: number };
    };
    expect(stored).toMatchObject({
      schemaVersion: 2,
      spec: { schemaVersion: 2 },
      lease: { schemaVersion: 2 },
    });
  });

  it("enforces one writer and rejects expired or invalid capabilities immediately", async () => {
    const { adapter, make, now } = await harness();
    const runtime = make();
    const first = await runtime.start({
      spec: baseSpec("s1"),
      holderId: "runner",
      correlationId: "c1",
      leaseDurationMs: 2_000,
    });
    await expect(
      runtime.start({ spec: baseSpec("s2"), holderId: "runner", correlationId: "c2" }),
    ).rejects.toThrow(/already has writer/);
    await expect(runtime.startAction("wrong", command("s1", "a1"))).rejects.toThrow(/capability rejected/);
    now.value = new Date("2026-07-11T12:00:03.000Z");
    await expect(runtime.startAction(first.token, command("s1", "a1"))).rejects.toThrow(/expired/);
    // The lapse pauses the body in place instead of destroying the session.
    expect(adapter.sessions.get("adapter-s1")).toMatchObject({ stops: 0, pauses: 1 });
    // A lapsed claim does not block the next writer on the body...
    await expect(
      runtime.start({ spec: baseSpec("s2"), holderId: "runner", correlationId: "c2" }),
    ).resolves.toBeDefined();
    // ...and once someone else holds it, the lapsed session cannot renew back in.
    await expect(runtime.renew(first.token, "s1")).rejects.toThrow(/already has writer/);
  });

  it("renews the lease on use and resumes a lapsed session exactly where it paused", async () => {
    const { adapter, events, make, now } = await harness();
    const runtime = make();
    const { token } = await runtime.start({
      spec: baseSpec("s1"),
      holderId: "runner",
      correlationId: "c1",
      leaseDurationMs: 2_000,
    });
    // Each dispatch renews the claim, so steady play outlives the raw duration.
    now.value = new Date("2026-07-11T12:00:01.500Z");
    await expect(runtime.startAction(token, command("s1", "a1"))).resolves.toBeDefined();
    now.value = new Date("2026-07-11T12:00:03.000Z");
    await expect(runtime.startAction(token, command("s1", "a2"))).resolves.toBeDefined();
    // Idling past the window lapses the claim and pauses the body.
    now.value = new Date("2026-07-11T12:00:10.000Z");
    await expect(runtime.startAction(token, command("s1", "a3"))).rejects.toThrow(/expired/);
    const session = adapter.sessions.get("adapter-s1")!;
    expect(session).toMatchObject({ stops: 0, pauses: 1 });
    // Renewal re-acquires the claim and resumes the same adapter session.
    await expect(runtime.renew(token, "s1")).resolves.toMatchObject({ phase: "active" });
    expect(session.resumes).toBe(1);
    await expect(runtime.startAction(token, command("s1", "a4"))).resolves.toBeDefined();
    expect(session.started).toEqual(["a1", "a2", "a4"]);
    const types = events.map((event) => (event as { type?: string }).type);
    expect(types).toContain("environment.session.lease_expired");
    expect(types).toContain("environment.session.lease_renewed");
  });

  it("never lets renewal undo a deliberate safety pause", async () => {
    const { adapter, make, now } = await harness();
    const runtime = make();
    const { token } = await runtime.start({
      spec: baseSpec("s1"),
      holderId: "runner",
      correlationId: "c1",
      leaseDurationMs: 2_000,
    });
    await runtime.pause(token, "s1", "state looks uncertain");
    now.value = new Date("2026-07-11T12:00:10.000Z");
    await expect(runtime.startAction(token, command("s1", "a1"))).rejects.toThrow(/expired/);
    // Renewal extends the claim but only resumes the pause the lapse caused.
    await expect(runtime.renew(token, "s1")).resolves.toMatchObject({ phase: "paused" });
    expect(adapter.sessions.get("adapter-s1")?.resumes).toBe(0);
    await runtime.resume(token, "s1");
    await expect(runtime.startAction(token, command("s1", "a2"))).resolves.toBeDefined();
  });

  it("makes action registration/cancellation, timeout, pause, and emergency stop idempotent", async () => {
    const { adapter, make, now } = await harness();
    const runtime = make();
    const { token } = await runtime.start({
      spec: baseSpec("s1"),
      holderId: "runner",
      correlationId: "c1",
      leaseDurationMs: 10_000,
    });
    await runtime.startAction(token, command("s1", "a1"));
    await runtime.startAction(token, command("s1", "a1"));
    expect(adapter.sessions.get("adapter-s1")?.started).toEqual(["a1"]);
    await runtime.pause(token, "s1", "operator pause");
    await runtime.resume(token, "s1");
    await runtime.startAction(token, command("s1", "a2"));
    now.value = new Date("2026-07-11T12:00:02.000Z");
    expect(await runtime.sweep()).toMatchObject({ timedOutActions: ["a2"] });
    await runtime.startAction(token, command("s1", "a3"));
    const stopped = await runtime.emergencyStop("s1", "danger");
    expect(stopped.phase).toBe("off");
    expect(adapter.sessions.get("adapter-s1")?.cancelled).toEqual(["a1", "a2", "a3"]);
    await expect(runtime.startAction(token, command("s1", "a4"))).rejects.toThrow(/revoked/);
    // Revocation is final: renewal recovers a lapse, never an emergency stop.
    await expect(runtime.renew(token, "s1")).rejects.toThrow(/revoked/);
    await expect(runtime.emergencyStop("s1", "again")).resolves.toMatchObject({ phase: "off" });
  });

  it("settles adapter-owned background work without blocking pause and cancellation", async () => {
    const { adapter, make } = await harness();
    const runtime = make();
    const { token } = await runtime.start({
      spec: baseSpec("background"),
      holderId: "runner",
      correlationId: "background",
    });
    const session = adapter.sessions.get("adapter-background")!;
    session.background = true;

    await expect(runtime.startAction(token, command("background", "long-action"))).resolves.toMatchObject({
      status: "running",
    });
    await expect(runtime.pause(token, "background", "operator pause")).resolves.toMatchObject({
      phase: "paused",
    });
    expect(session.cancelled).toEqual(["long-action"]);

    session.finishBackground({ ignored: true });
    await Promise.resolve();
    await expect(runtime.actionStatus(token, "background", "long-action")).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("reattaches exactly once after restart and never repeats completed actions", async () => {
    const { adapter, make } = await harness();
    const first = make();
    const { token } = await first.start({ spec: baseSpec("s1"), holderId: "runner", correlationId: "c1" });
    await first.startAction(token, command("s1", "a1"));
    await first.finishAction(token, "s1", "a1", { result: "ok" });
    const restarted = make();
    expect(await restarted.reconcile()).toMatchObject({ attached: ["s1"] });
    expect(await restarted.reconcile()).toMatchObject({ retained: ["s1"] });
    await expect(restarted.startAction(token, command("s1", "a1"))).resolves.toMatchObject({
      status: "completed",
    });
    expect(adapter.sessions.get("adapter-s1")?.started).toEqual(["a1"]);
    expect(adapter.attaches).toBe(1);
    adapter.sessions.clear();
    expect(await make().reconcile()).toMatchObject({ failed: ["s1"] });
  });

  it("redacts credentials and grants from output, logs, state, and telemetry", async () => {
    const { events, make, rootDir } = await harness();
    const runtime = make();
    const { token } = await runtime.start({
      spec: baseSpec("s1"),
      holderId: "runner",
      correlationId: "grant-marker",
      connection: { password: "credential-marker" },
    });
    await runtime.startAction(token, command("s1", "a1"));
    const result = await runtime.finishAction(token, "s1", "a1", {
      echo: "credential-marker grant-marker",
      accessToken: "credential-marker",
    });
    expect(JSON.stringify(result)).not.toMatch(/credential-marker|grant-marker/);
    const telemetry = await runtime.publishTelemetry(token, {
      schemaVersion: 1,
      plane: "artifact_reference",
      id: "telemetry-1",
      telemetryKind: "packets",
      sessionId: "s1",
      correlationId: "c1",
      artifactId: "artifact-1",
      uri: "artifact://environment/credential-marker",
      summary: "grant-marker trace",
      capturedAt: "2026-07-11T12:00:00.000Z",
    });
    expect(JSON.stringify(telemetry)).not.toMatch(/credential-marker|grant-marker/);
    expect(JSON.stringify(events)).not.toMatch(/credential-marker|grant-marker/);
    const file = (await readdir(join(rootDir, "environment-sessions"))).find((name) =>
      name.endsWith(".json"),
    )!;
    expect(await readFile(join(rootDir, "environment-sessions", file), "utf8")).not.toMatch(
      /credential-marker|grant-marker/,
    );
    await expect(runtime.heartbeat(token, "s1")).resolves.toMatchObject({ phase: "active" });
  });

  it("keeps emergency stop off the shared adapter queue when a dispatch hangs (VUH-770 c2/c3)", async () => {
    const { adapter, make } = await harness();
    const runtime = make();
    const first = await runtime.start({
      spec: baseSpec("s1"),
      holderId: "runner",
      correlationId: "c1",
      leaseDurationMs: 10_000,
    });
    // (c2) A hung adapter startAction must not starve the kill switch.
    const hung = adapter.sessions.get("adapter-s1")!;
    hung.hangStartAction = true;
    const parked = runtime.startAction(first.token, command("s1", "a1"));
    parked.catch(() => undefined);
    const stopped = await runtime.emergencyStop("s1", "danger");
    expect(stopped.phase).toBe("off");
    expect(hung.stops).toBe(1);
    // (c3) A hung adapter cancelAction on a running action must not starve it either.
    const second = await runtime.start({
      spec: baseSpec("s2"),
      holderId: "runner",
      correlationId: "c2",
      leaseDurationMs: 10_000,
    });
    await runtime.startAction(second.token, command("s2", "b1"));
    adapter.sessions.get("adapter-s2")!.hangCancelAction = true;
    await expect(runtime.emergencyStop("s2", "danger")).resolves.toMatchObject({ phase: "off" });
  }, 10_000);

  it("keeps connection-secret redaction durable across restart via reconcile re-provisioning (VUH-770 f2)", async () => {
    const { events, make, rootDir } = await harness();
    const before = make();
    const { token } = await before.start({
      spec: baseSpec("s1"),
      holderId: "runner",
      correlationId: "c1",
      connection: { password: "connection-marker" },
    });
    await before.startAction(token, command("s1", "a1"));
    const restarted = make();
    await restarted.reconcile({ s1: { password: "connection-marker" } });
    await restarted.startAction(token, command("s1", "a2"));
    const result = await restarted.finishAction(token, "s1", "a2", {
      echo: "adapter echoed connection-marker into an outcome field",
    });
    expect(JSON.stringify(result)).not.toMatch(/connection-marker/);
    expect(JSON.stringify(events)).not.toMatch(/connection-marker/);
    const file = (await readdir(join(rootDir, "environment-sessions"))).find((name) =>
      name.endsWith(".json"),
    )!;
    expect(await readFile(join(rootDir, "environment-sessions", file), "utf8")).not.toMatch(
      /connection-marker/,
    );
  });
});
