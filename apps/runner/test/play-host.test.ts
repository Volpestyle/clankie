import type {
  EmbodimentAssignment,
  EmbodimentClaim,
  EmbodimentLifecycleReport,
  EmbodimentSession,
} from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { PlayHost, type PlayExecution } from "../src/play-host.ts";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function session(partial: Partial<EmbodimentSession> = {}): EmbodimentSession {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    environmentId: "pokemon-firered",
    state: "claimed",
    intentId: "intent-1",
    originLane: "discord_presence",
    requestedBy: "user-1",
    budget: { maxTurns: 5, maxDurationMs: 60_000 },
    requestedAt: "2026-07-26T12:00:00.000Z",
    updatedAt: "2026-07-26T12:00:01.000Z",
    runnerId: "runner-local",
    ...partial,
  };
}

interface FakeClientOptions {
  assignments?: EmbodimentAssignment[];
  live?: EmbodimentSession;
}

function fakeClient(options: FakeClientOptions = {}) {
  const assignments = [...(options.assignments ?? [])];
  const reports: EmbodimentLifecycleReport[] = [];
  const claims: EmbodimentClaim[] = [];
  return {
    reports,
    claims,
    claimEmbodiment(claim: EmbodimentClaim): Promise<EmbodimentAssignment | undefined> {
      claims.push(claim);
      return Promise.resolve(assignments.shift());
    },
    reportEmbodiment(report: EmbodimentLifecycleReport): Promise<unknown> {
      reports.push(report);
      return Promise.resolve({});
    },
    getLiveEmbodimentSession(): Promise<EmbodimentSession | undefined> {
      return Promise.resolve(options.live);
    },
  };
}

function host(client: ReturnType<typeof fakeClient>, execute: PlayExecution) {
  return new PlayHost({
    client,
    runnerId: "runner-local",
    environmentIds: ["pokemon-firered"],
    execute,
    logger: silentLogger,
  });
}

describe("PlayHost", () => {
  it("claims a start, reports running with lineage, then stopped with the receipt", async () => {
    const client = fakeClient({ assignments: [{ kind: "start", session: session() }] });
    const subject = host(client, async (_session, _control, onRunning) => {
      await onRunning("checkpoint-8");
      return {
        kind: "ran",
        result: {
          outcome: "budget_exhausted",
          turnsTaken: 5,
          durationMs: 1_000,
          framesPublished: 40,
          framesDropped: 0,
          checkpointId: "checkpoint-9",
          resumedFromCheckpointId: "checkpoint-8",
        },
      };
    });
    expect(await subject.poll()).toBe(true);
    await subject.settled();
    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
    expect(client.reports[0]).toMatchObject({ resumedFromCheckpointId: "checkpoint-8" });
    expect(client.reports[1]?.receipt).toMatchObject({
      outcome: "budget_exhausted",
      checkpointId: "checkpoint-9",
      framesPublished: 40,
    });
  });

  it("reports a refusal without ever reporting running", async () => {
    const client = fakeClient({ assignments: [{ kind: "start", session: session() }] });
    const subject = host(client, () => Promise.resolve({ kind: "refused", reason: "body_held" }));
    await subject.poll();
    await subject.settled();
    expect(client.reports).toHaveLength(1);
    expect(client.reports[0]).toMatchObject({ state: "refused", refusalReason: "body_held" });
  });

  it("delivers a stop to the in-flight session at the next turn boundary", async () => {
    const client = fakeClient({
      assignments: [
        { kind: "start", session: session() },
        { kind: "stop", sessionId: "session-1" },
      ],
    });
    let sawStop = false;
    const subject = host(client, async (_session, control, onRunning) => {
      await onRunning();
      // Simulated playthrough: wait until the host flips the stop flag.
      while (!control.stopRequested()) await new Promise((tick) => setTimeout(tick, 1));
      sawStop = true;
      return {
        kind: "ran",
        result: { outcome: "stopped", turnsTaken: 2, durationMs: 10, framesPublished: 4, framesDropped: 0 },
      };
    });
    expect(await subject.poll()).toBe(true);
    expect(await subject.poll()).toBe(false);
    await subject.settled();
    expect(sawStop).toBe(true);
    expect(client.reports.at(-1)).toMatchObject({ state: "stopped" });
    expect(client.reports.at(-1)?.receipt).toMatchObject({ outcome: "stopped" });
  });

  it("reports failed with a receipt when the execution throws mid-run", async () => {
    const client = fakeClient({ assignments: [{ kind: "start", session: session() }] });
    const subject = host(client, async (_session, _control, onRunning) => {
      await onRunning();
      throw new Error("core exploded");
    });
    await subject.poll();
    await subject.settled();
    expect(client.reports.map((report) => report.state)).toEqual(["running", "failed"]);
    expect(client.reports[1]?.receipt).toMatchObject({ outcome: "failed" });
  });

  it("reconciles a dead process's running session as failed lease_lapsed", async () => {
    const client = fakeClient({ live: session({ state: "running" }) });
    const subject = host(client, () => Promise.reject(new Error("never called")));
    await subject.reconcile();
    expect(client.reports).toHaveLength(1);
    expect(client.reports[0]).toMatchObject({ state: "failed" });
    expect(client.reports[0]?.receipt).toMatchObject({ outcome: "lease_lapsed" });
  });

  it("reconciles a dead process's claimed session as refused, not failed", async () => {
    const client = fakeClient({ live: session({ state: "claimed" }) });
    const subject = host(client, () => Promise.reject(new Error("never called")));
    await subject.reconcile();
    expect(client.reports[0]).toMatchObject({
      state: "refused",
      refusalReason: "environment_unavailable",
    });
  });

  it("leaves another runner's live session alone", async () => {
    const client = fakeClient({ live: session({ state: "running", runnerId: "runner-other" }) });
    const subject = host(client, () => Promise.reject(new Error("never called")));
    await subject.reconcile();
    expect(client.reports).toHaveLength(0);
  });

  it("refuses a double-assigned start instead of running two sessions", async () => {
    const client = fakeClient({
      assignments: [
        { kind: "start", session: session() },
        { kind: "start", session: session({ sessionId: "session-2" }) },
      ],
    });
    let releases: (() => void) | undefined;
    const subject = host(client, async (_session, _control, onRunning) => {
      await onRunning();
      await new Promise<void>((release) => {
        releases = release;
      });
      return {
        kind: "ran",
        result: { outcome: "stopped", turnsTaken: 1, durationMs: 1, framesPublished: 0, framesDropped: 0 },
      };
    });
    await subject.poll();
    await subject.poll();
    expect(client.reports.filter((report) => report.state === "refused")).toHaveLength(1);
    expect(client.reports.find((report) => report.state === "refused")?.sessionId).toBe("session-2");
    releases?.();
    await subject.settled();
  });
});
