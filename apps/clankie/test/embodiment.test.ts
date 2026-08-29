import type { EmbodimentIntent } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  EmbodimentManager,
  isEmbodimentEventType,
  type EmbodimentEventInput,
  type EmbodimentLifecycleUpdate,
} from "../src/embodiment.ts";

interface HarnessOptions {
  decide?: (intent: EmbodimentIntent) => "allow" | "deny" | "require_approval";
  startWindowMs?: number;
}

function harness(options: HarnessOptions = {}) {
  let now = new Date("2026-07-26T12:00:00.000Z");
  let nextId = 0;
  const events: EmbodimentEventInput[] = [];
  const manager = new EmbodimentManager({
    clock: () => now,
    idFactory: () => `session-${++nextId}`,
    decide: options.decide ?? (() => "allow"),
    ...(options.startWindowMs === undefined ? {} : { startWindowMs: options.startWindowMs }),
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

function startIntent(intentId = "intent-1", extras: { venue?: "local" | "world" } = {}): EmbodimentIntent {
  return {
    kind: "start",
    schemaVersion: 1,
    intentId,
    originLane: "discord_presence",
    requestedBy: "user-1",
    requestedAt: "2026-07-26T12:00:00.000Z",
    environmentId: "pokemon-firered",
    budget: { maxTurns: 40, maxDurationMs: 30 * 60 * 1_000 },
    ...extras,
  };
}

function report(partial: Omit<EmbodimentLifecycleUpdate, "sessionId">): EmbodimentLifecycleUpdate {
  return {
    sessionId: "session-1",
    ...partial,
  } as EmbodimentLifecycleUpdate;
}

const environmentIds = ["pokemon-firered"] as const;

describe("EmbodimentManager", () => {
  it("runs the asked lifecycle: submit, claim, running, stop, stopped", async () => {
    const test = harness();
    const submitted = await test.manager.submit(startIntent());
    expect(submitted).toMatchObject({ outcome: "accepted", session: { state: "requested" } });

    const assignment = await test.manager.claim(environmentIds);
    expect(assignment).toMatchObject({
      kind: "start",
      session: { state: "claimed" },
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

    // The pending stop is re-delivered to the local host on every poll.
    expect(await test.manager.claim(environmentIds)).toEqual({ kind: "stop", sessionId: "session-1" });

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

  it("answers a repeat start for the environment he is already playing with the live session", async () => {
    // The embodiment mirror of ADR 0062's never-rejoin: already being at the
    // controls satisfies the ask. Tearing down and restarting would lose the
    // run; refusing reads as "someone else is driving" when the driver is him.
    const test = harness();
    await test.manager.submit(startIntent());
    const second = await test.manager.submit(startIntent("intent-2"));
    expect(second).toMatchObject({ outcome: "accepted", session: { intentId: "intent-1" } });
    expect(test.manager.liveSession()?.intentId).toBe("intent-1");
    // No second session was minted for the repeat ask.
    expect(second.outcome === "accepted" && second.session.sessionId).toBe("session-1");
  });

  it("does not treat a world join as the same ask as a local start", async () => {
    const test = harness();
    await test.manager.submit(startIntent());
    const world = await test.manager.submit(startIntent("intent-world", { venue: "world" }));
    expect(world).toMatchObject({ outcome: "refused", reason: "play_session_active" });
  });

  it("records a world venue on the session so the local host can dispatch", async () => {
    const test = harness();
    const submitted = await test.manager.submit(startIntent("intent-1", { venue: "world" }));
    expect(submitted).toMatchObject({
      outcome: "accepted",
      session: { venue: "world" },
    });
  });

  it("still refuses a start while the live session is winding down", async () => {
    const test = harness();
    await test.manager.submit(startIntent());
    await test.manager.claim(environmentIds);
    await test.manager.report(report({ state: "running" }));
    await test.manager.submit({
      kind: "stop",
      schemaVersion: 1,
      intentId: "intent-stop",
      originLane: "discord_presence",
      requestedBy: "user-1",
      requestedAt: "2026-07-26T12:02:00.000Z",
      sessionId: "session-1",
    });
    await test.manager.report(report({ state: "stopping" }));
    const during = await test.manager.submit(startIntent("intent-3"));
    expect(during).toMatchObject({ outcome: "refused", reason: "play_session_active" });
    // The refusal minted a queryable terminal session, not a dropped request.
    expect(during.outcome === "refused" && during.sessionId).toBeTruthy();
  });

  it("refuses when policy does not allow, and approval-shaped means no", async () => {
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

  it("expires starts the local host never begins", async () => {
    const test = harness({ startWindowMs: 10_000 });
    await test.manager.submit(startIntent());
    test.advance(11_000);
    expect(await test.manager.claim(environmentIds)).toBeUndefined();
    expect(test.manager.getSession("session-1")).toMatchObject({
      state: "refused",
      refusalReason: "environment_unavailable",
    });

    await test.manager.submit(startIntent("intent-2"));
    const assignment = await test.manager.claim(environmentIds);
    expect(assignment?.kind).toBe("start");
    test.advance(11_000);
    // Claimed but never started: the local host failed during boot.
    await test.manager.submit(startIntent("intent-3"));
    expect(test.manager.getSession("session-2")).toMatchObject({
      state: "refused",
      refusalReason: "environment_unavailable",
    });
  });

  it("rejects unknown sessions and illegal local transitions", async () => {
    const test = harness();
    await test.manager.submit(startIntent());
    await test.manager.claim(environmentIds);
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
    await test.manager.claim(environmentIds);
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
    // The pending stop survives restart and is delivered to the local host.
    expect(await restarted.manager.claim(environmentIds)).toEqual({ kind: "stop", sessionId: "session-1" });
  });

  it("maps obsolete refusal names while replaying durable events", () => {
    for (const [legacy, current] of [
      ["body_held", "play_session_active"],
      ["no_runner", "environment_unavailable"],
    ] as const) {
      const test = harness();
      test.manager.applyEvent({
        type: "embodiment.intent.submitted",
        occurredAt: "2026-07-26T12:00:00.000Z",
        data: {
          sessionId: "session-legacy",
          intentId: "intent-legacy",
          environmentId: "pokemon-firered",
          originLane: "operator",
          requestedBy: "owner",
          budget: {},
        },
      });
      test.manager.applyEvent({
        type: "embodiment.session.refused",
        occurredAt: "2026-07-26T12:00:01.000Z",
        data: { sessionId: "session-legacy", reason: legacy },
      });
      expect(test.manager.getSession("session-legacy")).toMatchObject({
        state: "refused",
        refusalReason: current,
      });
    }
  });
});
