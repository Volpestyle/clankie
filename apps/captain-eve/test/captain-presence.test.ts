import type { CaptainPresenceReport } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { CaptainPresenceReporter } from "../lib/presence/reporter.ts";

function harness() {
  const reports: CaptainPresenceReport[] = [];
  const reporter = new CaptainPresenceReporter({
    leaseId: "lease-1",
    generationId: "generation-1",
    clock: () => new Date("2026-07-11T12:00:00.000Z"),
    scheduleHeartbeats: false,
    transport: {
      send(report) {
        reports.push(report);
        return Promise.resolve();
      },
    },
  });
  return { reporter, reports };
}

describe("CaptainPresenceReporter", () => {
  it("projects working, waiting-user attention, answer, and idle from durable Eve facts", async () => {
    const test = harness();
    await test.reporter.turnStarted({
      sessionId: "session-1",
      turnId: "turn-1",
      eventId: "turn-started:turn-1",
      occurredAt: "2026-07-11T12:00:01.000Z",
    });
    await test.reporter.waitingUser({
      sessionId: "session-1",
      turnId: "turn-1",
      eventId: "input-requested:turn-1:2",
      occurredAt: "2026-07-11T12:00:02.000Z",
      requests: [{ callId: "call-1", summary: "Captain asked for operator input" }],
    });
    await test.reporter.sessionWaiting({
      sessionId: "session-1",
      turnId: "turn-1",
      eventId: "waiting-before-answer",
      occurredAt: "2026-07-11T12:00:03.000Z",
    });
    await test.reporter.inputResolved({
      sessionId: "session-1",
      turnId: "turn-1",
      eventId: "input-resolved:turn-1:call-1",
      occurredAt: "2026-07-11T12:00:04.000Z",
      callId: "call-1",
    });
    await test.reporter.sessionWaiting({
      sessionId: "session-1",
      turnId: "turn-1",
      eventId: "waiting-after-answer",
      occurredAt: "2026-07-11T12:00:05.000Z",
    });

    expect(test.reports.map((report) => report.type)).toEqual([
      "captain.heartbeat",
      "captain.turn.started",
      "captain.turn.settled",
      "captain.turn.started",
      "captain.turn.settled",
    ]);
    expect(test.reports[2]).toMatchObject({
      type: "captain.turn.settled",
      state: "waiting_user",
      questionSummary: "Captain asked for operator input",
    });
    expect(JSON.stringify(test.reports)).not.toContain("prompt");
    expect(test.reports.at(-1)).toMatchObject({ type: "captain.turn.settled", state: "idle" });
  });

  it("reports dependency waits until the structured dependency clears", async () => {
    const test = harness();
    test.reporter.noteDependency("session-1", "mission:m-1", "Waiting for mission workers");
    await test.reporter.sessionWaiting({
      sessionId: "session-1",
      turnId: "turn-1",
      eventId: "waiting:turn-1",
      occurredAt: "2026-07-11T12:00:01.000Z",
    });
    expect(test.reports.at(-1)).toMatchObject({
      type: "captain.waiting_dependency",
      summary: "Waiting for mission workers",
    });

    test.reporter.resolveDependency("session-1", "mission:m-1");
    await test.reporter.sessionWaiting({
      sessionId: "session-1",
      turnId: "turn-2",
      eventId: "waiting:turn-2",
      occurredAt: "2026-07-11T12:00:02.000Z",
    });
    expect(test.reports.at(-1)).toMatchObject({ type: "captain.turn.settled", state: "idle" });
  });

  it("retries initial registration after a transport failure", async () => {
    const reports: CaptainPresenceReport[] = [];
    let attempts = 0;
    const reporter = new CaptainPresenceReporter({
      leaseId: "lease-1",
      generationId: "generation-1",
      scheduleHeartbeats: false,
      transport: {
        send(report) {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("control plane unavailable"));
          reports.push(report);
          return Promise.resolve();
        },
      },
    });
    await expect(reporter.start()).rejects.toThrow("control plane unavailable");
    await expect(reporter.start()).resolves.toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.type).toBe("captain.heartbeat");
  });
});
