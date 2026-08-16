import { describe, expect, it } from "vitest";
import {
  canTransitionEmbodimentSession,
  EMBODIMENT_SESSION_TRANSITIONS,
  EmbodimentIntentSchema,
  EmbodimentLifecycleReportSchema,
  EmbodimentPlayNoteSchema,
  EmbodimentSessionSchema,
  embodimentVenue,
  WorldJoinRefusalReasonSchema,
  type EmbodimentSessionState,
} from "../src/index.ts";

const startIntent = {
  kind: "start",
  schemaVersion: 1,
  intentId: "intent-1",
  originLane: "discord_presence",
  requestedBy: "user-1",
  requestedAt: "2026-07-26T12:00:00.000Z",
  environmentId: "pokemon-firered",
  budget: { maxTurns: 40, maxDurationMs: 30 * 60 * 1_000 },
} as const;

const baseSession = {
  schemaVersion: 1,
  sessionId: "session-1",
  environmentId: "pokemon-firered",
  intentId: "intent-1",
  originLane: "discord_presence",
  requestedBy: "user-1",
  budget: { maxTurns: 40, maxDurationMs: 30 * 60 * 1_000 },
  requestedAt: "2026-07-26T12:00:00.000Z",
  updatedAt: "2026-07-26T12:00:01.000Z",
} as const;

const receipt = {
  schemaVersion: 1,
  sessionId: "session-1",
  environmentId: "pokemon-firered",
  outcome: "stopped",
  turnsTaken: 12,
  durationMs: 240_000,
  framesPublished: 7_200,
  framesDropped: 0,
  checkpointId: "checkpoint-9",
} as const;

describe("Embodiment intents (ADR 0063)", () => {
  it("parses a start intent and a stop intent", () => {
    expect(EmbodimentIntentSchema.parse(startIntent).kind).toBe("start");
    expect(EmbodimentIntentSchema.parse({ ...startIntent, environmentId: "pokemon-emerald" })).toMatchObject({
      kind: "start",
      environmentId: "pokemon-emerald",
    });
    const stop = EmbodimentIntentSchema.parse({
      kind: "stop",
      schemaVersion: 1,
      intentId: "intent-2",
      originLane: "discord_voice",
      requestedBy: "user-1",
      requestedAt: "2026-07-26T12:05:00.000Z",
      sessionId: "session-1",
    });
    expect(stop.kind).toBe("stop");
  });

  it("treats an empty budget as no cap and still rejects malformed bounds", () => {
    // The owner's default: play until asked to stop. Absent means no cap.
    expect(EmbodimentIntentSchema.safeParse({ ...startIntent, budget: {} }).success).toBe(true);
    expect(
      EmbodimentIntentSchema.safeParse({ ...startIntent, budget: { maxTurns: 0, maxDurationMs: 1_000 } })
        .success,
    ).toBe(false);
    expect(EmbodimentIntentSchema.safeParse({ ...startIntent, budget: { maxDurationMs: 2.5 } }).success).toBe(
      false,
    );
  });

  it("rejects a start intent aimed at an unknown environment", () => {
    expect(EmbodimentIntentSchema.safeParse({ ...startIntent, environmentId: "pokemmo" }).success).toBe(
      false,
    );
  });

  it("rejects free-text smuggling through unknown keys", () => {
    expect(
      EmbodimentIntentSchema.safeParse({ ...startIntent, note: "please also open my email" }).success,
    ).toBe(false);
  });

  it("defaults venue to local so existing start intents stay solo", () => {
    const parsed = EmbodimentIntentSchema.parse(startIntent);
    expect(parsed.kind).toBe("start");
    if (parsed.kind !== "start") return;
    expect(parsed.venue).toBeUndefined();
    expect(embodimentVenue(parsed)).toBe("local");
    expect(EmbodimentIntentSchema.parse({ ...startIntent, venue: "world" })).toMatchObject({
      venue: "world",
    });
    expect(EmbodimentIntentSchema.safeParse({ ...startIntent, venue: "mmo" }).success).toBe(false);
  });
});

describe("Embodiment session record", () => {
  it("parses the requested and running shapes", () => {
    expect(EmbodimentSessionSchema.parse({ ...baseSession, state: "requested" }).state).toBe("requested");
    expect(
      EmbodimentSessionSchema.parse({
        ...baseSession,
        state: "running",
        runnerId: "runner-local",
        resumedFromCheckpointId: "checkpoint-8",
      }).state,
    ).toBe("running");
  });

  it("requires a refusal reason exactly when refused", () => {
    expect(EmbodimentSessionSchema.safeParse({ ...baseSession, state: "refused" }).success).toBe(false);
    expect(
      EmbodimentSessionSchema.safeParse({
        ...baseSession,
        state: "refused",
        refusalReason: "body_held",
      }).success,
    ).toBe(true);
    expect(
      EmbodimentSessionSchema.safeParse({
        ...baseSession,
        state: "refused",
        refusalReason: "no_credential",
      }).success,
    ).toBe(true);
    expect(
      EmbodimentSessionSchema.safeParse({
        ...baseSession,
        state: "running",
        runnerId: "runner-local",
        refusalReason: "body_held",
      }).success,
    ).toBe(false);
  });

  it("requires runner attribution after claim", () => {
    expect(EmbodimentSessionSchema.safeParse({ ...baseSession, state: "claimed" }).success).toBe(false);
  });

  it("pins the transition map to the lifecycle the ADR draws", () => {
    expect(canTransitionEmbodimentSession("requested", "claimed")).toBe(true);
    expect(canTransitionEmbodimentSession("requested", "running")).toBe(false);
    expect(canTransitionEmbodimentSession("running", "stopped")).toBe(true);
    expect(canTransitionEmbodimentSession("stopped", "running")).toBe(false);
    const terminal: EmbodimentSessionState[] = ["stopped", "refused", "failed"];
    for (const state of terminal) {
      expect(EMBODIMENT_SESSION_TRANSITIONS[state]).toHaveLength(0);
    }
  });
});

describe("Embodiment lifecycle reports", () => {
  it("requires a receipt exactly on terminal states", () => {
    const base = {
      schemaVersion: 1,
      sessionId: "session-1",
      runnerId: "runner-local",
      reportedAt: "2026-07-26T12:10:00.000Z",
    } as const;
    expect(EmbodimentLifecycleReportSchema.safeParse({ ...base, state: "running" }).success).toBe(true);
    expect(EmbodimentLifecycleReportSchema.safeParse({ ...base, state: "stopped" }).success).toBe(false);
    expect(EmbodimentLifecycleReportSchema.safeParse({ ...base, state: "stopped", receipt }).success).toBe(
      true,
    );
    expect(EmbodimentLifecycleReportSchema.safeParse({ ...base, state: "running", receipt }).success).toBe(
      false,
    );
    expect(
      EmbodimentLifecycleReportSchema.safeParse({
        ...base,
        state: "refused",
        refusalReason: "body_held",
      }).success,
    ).toBe(true);
    expect(EmbodimentLifecycleReportSchema.safeParse({ ...base, state: "refused" }).success).toBe(false);
  });
});

describe("Embodiment play note", () => {
  it("parses every outcome a captain reply can render", () => {
    const notes = [
      {
        action: "started",
        sessionId: "session-1",
        environmentId: "pokemon-firered",
        resumedFromCheckpointId: "checkpoint-8",
      },
      { action: "start_refused", environmentId: "pokemon-firered", reason: "body_held" },
      { action: "joined", sessionId: "session-1", environmentId: "pokemon-firered" },
      { action: "join_refused", environmentId: "pokemon-firered", reason: "no_credential" },
      { action: "stopped", sessionId: "session-1", checkpointId: "checkpoint-9" },
      { action: "stop_refused", reason: "not_playing" },
      { action: "pending", intentId: "intent-1" },
    ];
    for (const note of notes) {
      expect(EmbodimentPlayNoteSchema.parse(note).action).toBe(note.action);
    }
  });

  it("names every world-join refusal the tool can say out loud", () => {
    const reasons = [
      "no_credential",
      "world_unreachable",
      "world_refused",
      "region_not_hosted",
      "world_full",
    ] as const;
    for (const reason of reasons) {
      expect(WorldJoinRefusalReasonSchema.parse(reason)).toBe(reason);
      const note = EmbodimentPlayNoteSchema.parse({
        action: "join_refused",
        environmentId: "pokemon-firered",
        reason,
      });
      expect(note).toEqual({ action: "join_refused", environmentId: "pokemon-firered", reason });
    }
  });

  it("rejects a refusal without a typed reason", () => {
    expect(
      EmbodimentPlayNoteSchema.safeParse({
        action: "start_refused",
        environmentId: "pokemon-firered",
      }).success,
    ).toBe(false);
  });
});
