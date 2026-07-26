import type { EmbodimentClaim, EmbodimentIntent, EmbodimentLifecycleReport } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { EmbodimentManager, isEmbodimentEventType, type EmbodimentEventInput } from "../src/embodiment.ts";

interface HarnessOptions {
  decide?: (intent: EmbodimentIntent) => "allow" | "deny" | "require_approval";
  claimWindowMs?: number;
}

function harness(options: HarnessOptions = {}) {
  let now = new Date("2026-07-26T12:00:00.000Z");
  let nextId = 0;
  const events: EmbodimentEventInput[] = [];
  const manager = new EmbodimentManager({
    clock: () => now,
    idFactory: () => `session-${++nextId}`,
    decide: options.decide ?? (() => "allow"),
    ...(options.claimWindowMs === undefined ? {} : { claimWindowMs: options.claimWindowMs }),
    emit: (type, _sessionId, data) => {
      events.push({ type, occurredAt: now.toISOString(), data });
      return Promise.resolve();
    },
  });
  return {
    manager,
    events,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

function startIntent(intentId = "intent-1"): EmbodimentIntent {
  return {
    kind: "start",
    schemaVersion: 1,
    intentId,
    originLane: "discord_presence",
    requestedBy: "user-1",
    requestedAt: "2026-07-26T12:00:00.000Z",
    environmentId: "pokemon-firered",
    budget: { maxTurns: 40, maxDurationMs: 30 * 60 * 1_000 },
  };
}

function report(partial: Partial<EmbodimentLifecycleReport> & Pick<EmbodimentLifecycleReport, "state">) {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    runnerId: "runner-local",
    reportedAt: "2026-07-26T12:01:00.000Z",
    ...partial,
  } as EmbodimentLifecycleReport;
}

const claim: EmbodimentClaim = {
  schemaVersion: 1,
  claimId: "claim-1",
  runnerId: "runner-local",
  environmentIds: ["pokemon-firered"],
};

describe("EmbodimentManager", () => {
  it("runs the asked lifecycle: submit, claim, running, stop, stopped", async () => {
    const test = harness();
    const submitted = await test.manager.submit(startIntent());
    expect(submitted).toMatchObject({ outcome: "accepted", session: { state: "requested" } });

    const assignment = await test.manager.claim(claim);
    expect(assignment).toMatchObject({
      kind: "start",
      session: { state: "claimed", runnerId: "runner-local" },
    });

    const running = await test.manager.report(
      report({ state: "running", resumedFromCheckpointId: "checkpoint-8" }),
    );
    expect(running).toMatchObject({
      outcome: "applied",
      session: { state: "running", resumedFromCheckpointId: "checkpoint-8" },
    });

    const stop = await test.manager.submit({
      kind: "stop",
      schemaVersion: 1,
      intentId: "intent-2",
      originLane: "discord_voice",
      requestedBy: "user-1",
      requestedAt: "2026-07-26T12:05:00.000Z",
      sessionId: "session-1",
    });
    expect(stop).toMatchObject({ outcome: "stop_requested" });

    // The pending stop is re-delivered to the owning runner on every poll.
    expect(await test.manager.claim(claim)).toEqual({ kind: "stop", sessionId: "session-1" });
    expect(await test.manager.claim({ ...claim, runnerId: "runner-other" })).toBeUndefined();

    const stopped = await test.manager.report(
      report({
        state: "stopped",
        receipt: {
          schemaVersion: 1,
          sessionId: "session-1",
          environmentId: "pokemon-firered",
          outcome: "stopped",
          turnsTaken: 12,
          durationMs: 240_000,
          framesPublished: 7_200,
          framesDropped: 0,
          checkpointId: "checkpoint-9",
        },
      }),
    );
    expect(stopped).toMatchObject({
      outcome: "applied",
      session: { state: "stopped", checkpointId: "checkpoint-9" },
    });
    expect(test.manager.liveSession()).toBeUndefined();
  });

  it("refuses a second start while one session is live, before any runner claims it", async () => {
    const test = harness();
    await test.manager.submit(startIntent());
    const second = await test.manager.submit(startIntent("intent-2"));
    expect(second).toMatchObject({ outcome: "refused", reason: "body_held" });
    // The refusal minted a queryable terminal session, not a dropped request.
    expect(second.outcome === "refused" && second.sessionId).toBeTruthy();
    expect(test.manager.liveSession()?.intentId).toBe("intent-1");
  });

  it("refuses when doctrine does not allow, and approval-shaped means no", async () => {
    for (const verdict of ["deny", "require_approval"] as const) {
      const test = harness({ decide: () => verdict });
      const result = await test.manager.submit(startIntent());
      expect(result).toMatchObject({ outcome: "refused", reason: "policy" });
    }
  });

  it("refuses a stop when nothing is playing", async () => {
    const test = harness();
    const result = await test.manager.submit({
      kind: "stop",
      schemaVersion: 1,
      intentId: "intent-1",
      originLane: "discord_presence",
      requestedBy: "user-1",
      requestedAt: "2026-07-26T12:00:00.000Z",
      sessionId: "session-none",
    });
    expect(result).toMatchObject({ outcome: "refused", reason: "not_playing" });
  });

  it("expires unclaimed and claim-then-dead sessions as no_runner", async () => {
    const test = harness({ claimWindowMs: 10_000 });
    await test.manager.submit(startIntent());
    test.advance(11_000);
    expect(await test.manager.claim(claim)).toBeUndefined();
    expect(test.manager.getSession("session-1")).toMatchObject({
      state: "refused",
      refusalReason: "no_runner",
    });

    await test.manager.submit(startIntent("intent-2"));
    const assignment = await test.manager.claim(claim);
    expect(assignment?.kind).toBe("start");
    test.advance(11_000);
    // Claimed but never reported running: the runner died holding the claim.
    await test.manager.submit(startIntent("intent-3"));
    expect(test.manager.getSession("session-2")).toMatchObject({
      state: "refused",
      refusalReason: "no_runner",
    });
  });

  it("rejects reports from the wrong runner and illegal transitions", async () => {
    const test = harness();
    await test.manager.submit(startIntent());
    await test.manager.claim(claim);
    expect(await test.manager.report(report({ state: "running", runnerId: "runner-other" }))).toEqual({
      outcome: "rejected",
      error: "runner_mismatch",
    });
    // Terminal states are only reachable through running; a claimed session
    // that never ran can refuse or fail, never "stop".
    expect(
      await test.manager.report(
        report({
          state: "stopped",
          receipt: {
            schemaVersion: 1,
            sessionId: "session-1",
            environmentId: "pokemon-firered",
            outcome: "stopped",
            turnsTaken: 0,
            durationMs: 0,
            framesPublished: 0,
            framesDropped: 0,
          },
        }),
      ),
    ).toEqual({ outcome: "rejected", error: "illegal_transition" });
    expect(await test.manager.report(report({ state: "running" }))).toMatchObject({ outcome: "applied" });
    expect(
      await test.manager.report(
        report({
          state: "stopped",
          receipt: {
            schemaVersion: 1,
            sessionId: "session-1",
            environmentId: "pokemon-firered",
            outcome: "stopped",
            turnsTaken: 0,
            durationMs: 0,
            framesPublished: 0,
            framesDropped: 0,
          },
        }),
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(await test.manager.report(report({ state: "running" }))).toEqual({
      outcome: "rejected",
      error: "illegal_transition",
    });
    expect(await test.manager.report({ ...report({ state: "running" }), sessionId: "ghost" })).toEqual({
      outcome: "rejected",
      error: "unknown_session",
    });
  });

  it("rebuilds identical state from replayed events after restart", async () => {
    const test = harness();
    await test.manager.submit(startIntent());
    await test.manager.claim(claim);
    await test.manager.report(report({ state: "running" }));
    await test.manager.submit({
      kind: "stop",
      schemaVersion: 1,
      intentId: "intent-2",
      originLane: "discord_presence",
      requestedBy: "user-1",
      requestedAt: "2026-07-26T12:05:00.000Z",
      sessionId: "session-1",
    });

    const restarted = harness();
    for (const event of test.events) {
      expect(isEmbodimentEventType(event.type)).toBe(true);
      restarted.manager.applyEvent(event);
    }
    expect(restarted.manager.getSession("session-1")).toEqual(test.manager.getSession("session-1"));
    // The pending stop survives restart: the owning runner still receives it.
    expect(await restarted.manager.claim(claim)).toEqual({ kind: "stop", sessionId: "session-1" });
  });
});
